import { DurableObject } from 'cloudflare:workers';
import type { Env, SectorMeta, SessionPayload } from '../types';
import { buildDefaultTwilioSession } from '../middleware';
import { runTurn, amendInterruptedReply, retractLastExchange } from '../services/turn.service';
import { getSector } from '../services/sector.service';
import { getProducts } from '../services/catalog.service';
import { getOrders } from '../services/order.service';
import { getBookedDatetimes } from '../services/tool-router.service';
import { getCalendarBusy } from '../services/calendar';
import { saveTranscript } from '../services/transcript.service';
import { callStartNotice, recordConsent } from '../services/disclosure';
import { assistantNameOf, getVertical } from '../services/verticals';
import { createCallCache, transferKey, type CallCache } from '../services/call-context';
import { fixPhoneNumbers, isBackchannel, isDiscourseOnly, isEchoOf, type Stt } from './stt-deepgram';
import { createStt, createTts, missingVoiceSecret, type TtsProvider } from './voice-providers';
import { DEFAULT_VOICE, isDefaultVoice, resolveVoiceSettings, sttDiffers, voiceLines, type VoiceSettings } from '../services/voice-language';
import { verifyStreamToken, verifyCompactStreamToken } from '../utils/stream-token';
import { callerIdentity, getOrCreateCustomer } from '../utils/identity';
import { customerHashSalt, isProduction } from '../config';
import { cartesiaDrain } from './tts-cartesia';
import {
  createTelephonyAdapter, isTelephonyProvider, PREAUTH_HEADER, PROVIDER_HEADER,
  type CallStart, type TelephonyAdapter, type TelephonyProvider,
} from '../telephony';
import { businessForNumber, normalizeE164, PROVIDER_COUNTRY } from '../services/phone-numbers';
import { UsageMeter } from '../services/billing/meter';
import { recordUsage } from '../services/billing/service';

// One CallRelay instance per phone call: carrier media stream → Deepgram STT
// → runTurn() → Cartesia TTS, with barge-in.
//
// The carrier's WebSocket protocol (Twilio Media Streams, Exotel Voicebot,
// Plivo Audio Streams) lives entirely in a TelephonyAdapter (src/telephony/):
// this class only sees start/media/mark/stop events and hands back μ-law
// 8 kHz audio, marks and clears. "Twilio marks" below means the adapter's
// marks (Plivo calls them checkpoints).
//
// Turn-taking model:
//
//  • What the caller has *heard* is tracked with Twilio marks. Every chunk of
//    audio is followed by a named mark; Twilio echoes the mark back when
//    playback reaches it. Audio is sent much faster than it plays, so "we
//    finished sending" is not "they finished hearing" — the old code used the
//    former, which left barge-in disarmed for the last few seconds of every
//    reply (exactly when callers start talking).
//
//  • Turns run one at a time. A new utterance aborts the running turn and
//    waits for it to settle before starting, so two turns never race to
//    write history.
//
//  • An interrupted turn is committed to history as far as the caller heard
//    it. If they heard nothing and no tool ran (they kept talking through a
//    pause the endpointer took for the end of their sentence), the utterance
//    isn't dropped — it's prepended to the next one, so "I need an oil
//    change… for my Civic on Friday" reaches the model as one request.

// Fillers, re-prompts and the greeting are per language: voiceLines() in
// services/voice-language.ts (the English lines are the original ones).

// Don't honour a barge-in within this long of the assistant starting to
// speak. Guards against the leading edge of our own audio echoing back on a
// speakerphone and instantly cutting off the reply we just began.
const BARGE_IN_MIN_SPEAK_MS = 300;

// Dead-air watchdog: while a turn is still working and nothing is queued
// or playing, say something after this much silence — before the first
// chunk (FILLER_GRACE_MS), or in a gap later in the turn, e.g. after "Let me
// check that." while a tool and the next model round run (GAP_FILLER_MS).
// At most MAX_FILLERS per turn; runTurn's own timeout ends the wait.
const FILLER_GRACE_MS = 1200;
const GAP_FILLER_MS = 2000;
const MAX_FILLERS = 3;

// Caller silence once the assistant has finished speaking: after this long
// ask "Are you still there?", and after the same again say goodbye and hang
// up, rather than holding an open line in dead air.
const SILENCE_REPROMPT_MS = 8000;

// Caller speech this soon after a reply began speaking means they hadn't
// finished their turn (a pause mid-thought ended the utterance early): the
// reply is withdrawn and their words are joined to what they say now.
const CONTINUATION_MS = 2000;

// A transcript arriving this soon after our audio stopped can still be
// that audio's echo.
const ECHO_TAIL_MS = 1500;

interface SpokenChunk { text: string; played: boolean; filler: boolean }

// One caller turn's timing, saved with the transcript (transcripts.metrics).
// All ms. `at` is when the final transcript arrived, from call start; laps are
// runTurn checkpoints from the turn's start; firstAudio is when the first real
// chunk's synthesized audio began streaming to Twilio.
interface TurnMetric {
  n: number;
  at: number;
  text: string;
  queued: number;
  laps: [string, number][];
  firstAudio?: number;
  // Cartesia time to first audio byte for that first chunk.
  tts?: number;
  fillers: number;
  outcome: 'done' | 'interrupted' | 'dropped';
}

interface ActiveTurn {
  id: number;
  abort: AbortController;
  chunks: SpokenChunk[];
  // Set once barge-in froze this turn: marks Twilio echoes back after a
  // `clear` must not count as played.
  closed: boolean;
  // runTurn already wrote the full reply to history.
  committed: boolean;
  greeting: boolean;
  // When this reply's first real audio started playing.
  firstAudioAt?: number;
  // The caller cut in so soon that they were still mid-turn: the reply is
  // withdrawn, not recorded as interrupted (see CONTINUATION_MS).
  retracted?: boolean;
}

export class CallRelay extends DurableObject<Env> {
  // The carrier's media-stream socket (named for Twilio, the first carrier).
  private twWs?: WebSocket;
  private telephony: TelephonyAdapter = createTelephonyAdapter('twilio');
  // Stream credentials that arrived on the upgrade request rather than in the
  // start event: Exotel's ?t= token or a route-verified Basic auth (preauth),
  // Plivo's ?token=.
  private urlToken?: string;
  private preauthenticated = false;
  private stt: Stt = { sendAudio: () => {}, close: () => {} };
  private session?: SessionPayload;
  private urlBusinessType?: string;
  private callSid = 'relay';
  private transcriptFlushed = false;
  // The call-start AI/transcription notice, when the business has it on
  // (services/disclosure.ts). Logged to consent_records when the call ends.
  private notice?: { text: string; startedAt: Date; chunk: SpokenChunk; recorded: boolean };
  // Call-lifetime cache: sector metadata, product list, tool defs, history,
  // orders and booked-slot set all live here instead of round-tripping to
  // KV/D1 on every turn. See worker/src/services/call-context.ts.
  private cache: CallCache = createCallCache();

  private turnSeq = 0;
  private active?: ActiveTurn;
  // A turn (or the greeting) is generating or still sending audio.
  private turnInFlight = false;
  // Mark name → chunk, for audio sent but not yet played.
  private pendingMarks = new Map<string, SpokenChunk>();
  private markSeq = 0;
  private speakStartedAt = 0;
  private turnChain: Promise<void> = Promise.resolve();
  private transcriptGen = 0;
  // Utterance from an interrupted turn the caller never heard a reply to.
  private carryOver = '';
  private callStartedAt = Date.now();
  // Silence tracking (see SILENCE_REPROMPT_MS). quietSince is 0 until the
  // stream starts, so the timer only runs on a live call.
  private quietSince = 0;
  private silencePrompts = 0;
  private hangupWhenDone = false;
  // A transfer to staff was requested: close the stream (→ /twilio/after-stream
  // dials them) once the "connecting you" line has played. Not cancelled by
  // caller speech, unlike the silence goodbye.
  private endStreamWhenDone = false;
  // What the assistant said recently and when its audio last finished, for
  // echo detection (isEchoOf).
  private spokenLog: { text: string; at: number }[] = [];
  private lastAudioEndAt = 0;
  private metrics: TurnMetric[] = [];
  // Billing: provider usage counted in memory during the call and written
  // once after it (flushUsage, via waitUntil) — never on a turn's path.
  private meter = new UsageMeter();
  private streamStartedAt = 0;
  private usageFlushed = false;

  // Phone-line language + STT/TTS providers. Every call starts on the
  // default (English, Deepgram, Cartesia) — exactly the pipeline the US
  // business has always used, with no extra lookup before the greeting.
  // When the sector lookup (made on every call anyway) says the business
  // uses something else, applyVoice() switches over: see the 'start' event.
  private voice: VoiceSettings = DEFAULT_VOICE;
  private lines = voiceLines('en');
  private tts?: TtsProvider;
  private sttGen = 0;
  // Settles once the business's voice settings are known (or the lookup failed).
  private voiceReady: Promise<void> = Promise.resolve();

  private get ttsProvider(): TtsProvider {
    return this.tts ??= createTts(this.env, this.voice);
  }

  // The assistant is thinking or audible — the window in which caller speech
  // is an interruption rather than a new turn.
  private get agentActive(): boolean {
    return this.turnInFlight || this.pendingMarks.size > 0;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Query-string businessType is a fallback for our own synthetic test harness
    // (scripts/simulate-call.mjs), which connects with the full URL directly.
    // Twilio's real Media Streams client does not reliably forward the query
    // string from <Stream url="...">, so the 'start' event's customParameters
    // (set via <Parameter> in the TwiML) is the source of truth for real calls.
    this.urlBusinessType = url.searchParams.get('businessType') ?? undefined;
    const cfg = streamConfig(request);
    this.telephony = createTelephonyAdapter(cfg.provider);
    this.urlToken = cfg.urlToken;
    this.preauthenticated = cfg.preauthenticated;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.twWs = server;

    return new Response(null, { status: 101, webSocket: client });
  }

  // Opened only after the stream is authenticated, so an unauthenticated
  // connection never opens a (billed) Deepgram session. Startup overlaps the
  // greeting TTS, so the caller doesn't notice the delay.
  private startStt() {
    // A restart (applyVoice) supersedes an earlier socket still connecting.
    const gen = ++this.sttGen;
    createStt(
      this.env,
      this.voice,
      {
        endpointingMs: numEnv(this.env.DG_ENDPOINTING_MS),
        minConfidence: numEnv(this.env.DG_MIN_CONFIDENCE),
        bargeInMinWords: numEnv(this.env.DG_BARGE_IN_MIN_WORDS),
        isEcho: (text) => this.looksLikeEcho(text),
        // Mid-sentence speech must hold off "Are you still there?".
        onActivity: () => this.callerActive(),
        incompleteHoldMs: numEnv(this.env.DG_INCOMPLETE_HOLD_MS),
        statementHoldMs: numEnv(this.env.DG_STATEMENT_HOLD_MS),
        debug: /^(1|true)$/i.test(this.env.DG_DEBUG ?? ''),
      },
      (text) => { this.handleTranscript(fixPhoneNumbers(text)); },
      (reason) => { this.handleSpeechStart(reason); },
    )
      .then(s => {
        // The call may already have ended while Deepgram was connecting.
        if (this.twWs?.readyState !== WebSocket.OPEN || gen !== this.sttGen) { s.close(); return; }
        this.stt = s;
      })
      .catch(async (e) => {
        // The default socket failing doesn't matter if the business turns
        // out to use another provider — that one is starting instead.
        await this.voiceReady;
        if (gen !== this.sttGen) return;
        console.error('[stt startup]', e?.message || e);
        if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1011, 'STT startup failed');
      });
  }

  // Switches the call to the business's voice settings once the sector
  // lookup lands. A no-op for default settings (the US business).
  private applyVoice(voice: VoiceSettings) {
    if (isDefaultVoice(voice) || this.twWs?.readyState !== WebSocket.OPEN) return;
    const missing = missingVoiceSecret(this.env, voice);
    if (missing) {
      // Fail closed: a Hindi line must not quietly run on English providers.
      console.error(`[call] ${this.callSid.slice(-8)} voice config needs ${missing} — ending call`);
      this.reject(`missing ${missing}`);
      return;
    }
    console.log(`[call] ${this.callSid.slice(-8)} voice ${voice.language} stt=${voice.sttProvider} tts=${voice.ttsProvider}`);
    this.voice = voice;
    this.lines = voiceLines(voice.language);
    this.tts = createTts(this.env, voice);
    if (sttDiffers(voice)) {
      this.stt.close();
      this.stt = { sendAudio: () => {}, close: () => {} };
      this.startStt();
    }
  }

  private heardText(turn: ActiveTurn): string {
    if (turn.retracted) return '';
    return turn.chunks.filter(c => c.played && !c.filler).map(c => c.text).join(' ');
  }

  // Stops the assistant: aborts generation and synthesis, and tells the
  // carrier to drop audio it has buffered but not yet played.
  private bargeIn() {
    const turn = this.active;
    if (turn && !turn.closed) {
      turn.closed = true;
      // Cut in almost as soon as the reply began: they weren't finished.
      if (!turn.greeting && (!turn.firstAudioAt || Date.now() - turn.firstAudioAt < CONTINUATION_MS)) {
        turn.retracted = true;
        if (turn.committed) {
          const words = retractLastExchange(this.cache);
          if (words) this.carryOver = joinUtterances(words, this.carryOver);
          else turn.retracted = false;   // a tool ran — keep it on record
        }
        if (turn.retracted) console.log(`[turn] caller wasn't finished — withdrawing the reply`);
      }
      turn.abort.abort();
      // The reply was already committed in full but the caller cut the
      // audio short — rewrite history to what they actually heard.
      if (turn.committed && !turn.greeting && !turn.retracted) amendInterruptedReply(this.cache, this.heardText(turn));
    }
    this.pendingMarks.clear();
    this.sendToCarrier(this.telephony.clear());
  }

  // Sends adapter-built frames; false once the socket has closed.
  private sendToCarrier(frames: string[]): boolean {
    const ws = this.twWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    for (const f of frames) ws.send(f);
    return true;
  }

  // Fired the moment Deepgram reports speech — before any transcript exists,
  // so the assistant stops talking over the caller as early as possible.
  //
  // `reason` is 'vad' (Deepgram's SpeechStarted — earliest, but fires on line
  // noise and echo) or 'interim' (enough recognised words that aren't just
  // "mm-hmm"). VAD barge-in is off unless VOICE_BARGE_IN_ON_VAD=1.
  private handleSpeechStart(reason: 'vad' | 'interim') {
    this.callerActive();
    if (!this.agentActive) return;
    if (reason === 'vad' && !/^(1|true)$/i.test(this.env.VOICE_BARGE_IN_ON_VAD ?? '')) return;
    if (Date.now() - this.speakStartedAt < BARGE_IN_MIN_SPEAK_MS) return;
    console.log(`[barge-in] speech-start (${reason}) — stopping TTS`);
    this.bargeIn();
  }

  // Our own audio coming back from a speakerphone, heard while (or just
  // after) it played.
  private looksLikeEcho(text: string): boolean {
    const now = Date.now();
    if (this.pendingMarks.size === 0 && now - this.lastAudioEndAt > ECHO_TAIL_MS) return false;
    const spoken = this.spokenLog.filter(s => now - s.at < 20_000).map(s => s.text).join(' ');
    return isEchoOf(text, spoken, this.voice.language);
  }

  private handleTranscript(text: string) {
    if (!this.session || !this.twWs) return;
    if (this.looksLikeEcho(text)) {
      console.log(`[turn] ignoring echo of our own audio: "${text.slice(0, 60)}"`);
      return;
    }
    this.callerActive();

    // "Well," / "Um, so" with the assistant quiet: the caller is starting a
    // sentence. Keep it for their next utterance instead of answering it.
    if (!this.agentActive && isDiscourseOnly(text, this.voice.language)) {
      console.log(`[turn] holding filler words: "${text}"`);
      this.carryOver = joinUtterances(this.carryOver, text);
      return;
    }

    // "Uh huh" / "okay" while the assistant is mid-reply is the caller
    // listening, not taking the turn — unless what they've heard so far
    // asked them something, in which case "yeah" is the answer. Only played
    // audio and the chunk playing now count: a question still queued behind
    // it hasn't been asked yet.
    if (this.agentActive && isBackchannel(text, this.voice.language)) {
      const playing = this.pendingMarks.values().next().value as SpokenChunk | undefined;
      const asked = this.active?.chunks.some(c => !c.filler && (c.played || c === playing) && c.text.includes('?'));
      if (!asked) {
        console.log(`[turn] ignoring backchannel while agent active: "${text}"`);
        return;
      }
    }

    // Normally handleSpeechStart() already stopped the assistant; this is the
    // backstop when no speech-start signal arrived.
    if (this.agentActive) {
      console.log(`[barge-in] on transcript "${text.slice(0, 40)}"`);
      this.bargeIn();
    }

    const gen = ++this.transcriptGen;
    const receivedAt = Date.now();
    this.turnChain = this.turnChain
      .then(() => this.runOneTurn(text, gen, receivedAt))
      .catch(e => console.error('[turn chain]', e?.message || e));
  }

  // Plays one synthesized chunk and registers a mark for it. `started` is the
  // already-issued Cartesia request, so synthesis overlaps earlier playback.
  private async playChunk(turn: ActiveTurn, chunk: SpokenChunk, started: Promise<Response | null>) {
    const { signal } = turn.abort;
    const res = await started;
    if (res) this.meter.addTts(chunk.text); // the synthesis was requested, so it's billed
    if (signal.aborted || !res) {
      // Nobody will read this body; release it rather than leak the stream.
      await res?.body?.cancel().catch(() => {});
      return;
    }
    const ws = this.twWs!;
    const now = Date.now();
    if (!chunk.filler && !turn.firstAudioAt) turn.firstAudioAt = now;
    this.spokenLog = this.spokenLog.filter(s => now - s.at < 20_000);
    this.spokenLog.push({ text: chunk.text, at: now });
    await cartesiaDrain(res, (audio) => this.sendToCarrier(this.telephony.audio(audio)), signal);
    if (signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    const name = `m${++this.markSeq}`;
    this.pendingMarks.set(name, chunk);
    this.sendToCarrier(this.telephony.mark(name));
  }

  private startTurn(greeting: boolean): ActiveTurn {
    const turn: ActiveTurn = {
      id: ++this.turnSeq, abort: new AbortController(), chunks: [], closed: false, committed: false, greeting,
    };
    this.active = turn;
    this.turnInFlight = true;
    this.speakStartedAt = Date.now();
    return turn;
  }

  private endTurn(turn: ActiveTurn) {
    if (this.active === turn) this.turnInFlight = false;
  }

  private async runOneTurn(text: string, gen: number, receivedAt = Date.now()): Promise<void> {
    // Newer speech arrived while this one was queued — fold it forward.
    if (gen !== this.transcriptGen) {
      this.carryOver = joinUtterances(this.carryOver, text);
      return;
    }
    const utterance = joinUtterances(this.carryOver, text);
    this.carryOver = '';

    const turn = this.startTurn(false);
    const { signal } = turn.abort;
    const tag = this.callSid.slice(-8);
    const t0 = Date.now();
    const metric: TurnMetric = {
      n: this.metrics.length + 1, at: receivedAt - this.callStartedAt, text: utterance.slice(0, 80),
      queued: t0 - receivedAt, laps: [], fillers: 0, outcome: 'done',
    };
    if (this.metrics.length < 100) this.metrics.push(metric);

    // Chunks stream in from runTurn() as they become ready. Synthesis for a
    // chunk is kicked off the instant it arrives, so its TTFB overlaps with
    // whatever is still playing; only the draining to Twilio is chained, so
    // audio stays strictly sequential and barge-in stops it cleanly.
    let chunkChain: Promise<void> = Promise.resolve();
    let firstChunkLogged = false;
    // Chunks queued whose audio hasn't been handed to Twilio yet.
    let unsent = 0;

    const queue = (textToSay: string, filler: boolean) => {
      if (signal.aborted) return;
      const chunk: SpokenChunk = { text: textToSay, played: false, filler };
      turn.chunks.push(chunk);
      unsent++;
      const queuedAt = Date.now();
      const started = this.ttsProvider.start(textToSay, signal).catch((e) => {
        if (e?.name !== 'AbortError') console.error(`[${this.ttsProvider.name} start]`, e?.message || e);
        return null;
      });
      chunkChain = chunkChain.then(async () => {
        // Contained: one chunk failing must not reject the chain, or every
        // later chunk appended to it would be silently skipped.
        try {
          const res = await started;
          if (res && !firstChunkLogged && !filler && !signal.aborted) {
            firstChunkLogged = true;
            metric.firstAudio = Date.now() - t0;
            metric.tts = Date.now() - queuedAt;
            console.log(`[${tag}] ⏱ first-chunk-spoken: ${metric.firstAudio}ms`);
          }
          await this.playChunk(turn, chunk, Promise.resolve(res));
        } catch (e: any) {
          if (e?.name !== 'AbortError') console.error('[tts chunk]', e?.message || e);
        } finally {
          unsent--;
        }
      });
    };

    let realChunkSeen = false;
    let fillers = 0;
    let quietSince = Date.now();
    const watchdog = setInterval(() => {
      if (signal.aborted) return;
      const now = Date.now();
      if (unsent > 0 || this.pendingMarks.size > 0) { quietSince = now; return; }
      if (fillers >= MAX_FILLERS) return;
      if (now - quietSince < (realChunkSeen || fillers ? GAP_FILLER_MS : FILLER_GRACE_MS)) return;
      const pool = fillers === 0 && !realChunkSeen ? this.lines.fillers : this.lines.stillWorking;
      console.log(`[${tag}] dead air ${now - quietSince}ms — filler`);
      queue(pool[fillers % pool.length], true);
      fillers++;
      metric.fillers = fillers;
      quietSince = now;
    }, 250);

    try {
      const result = await runTurn(this.env, this.session!, this.callSid, utterance, {
        onChunk: (chunk) => { realChunkSeen = true; queue(chunk, false); },
        cache: this.cache,
        signal,
        heardText: () => this.heardText(turn),
        onLap: (label, ms) => { if (metric.laps.length < 40) metric.laps.push([label, ms]); },
        onUsage: (model, usage) => this.meter.addLlm(model, usage),
      });
      metric.outcome = !result.committed ? 'dropped' : result.interrupted ? 'interrupted' : 'done';
      if (!result.committed) {
        // Caller heard nothing of the reply — keep their words for the next turn.
        this.carryOver = joinUtterances(utterance, this.carryOver);
      } else if (!result.interrupted) {
        turn.committed = true;
      }
      clearInterval(watchdog);
      await chunkChain;
      if (this.cache.transferTo && !this.endStreamWhenDone) {
        await this.env.CACHE.put(transferKey(this.callSid), this.cache.transferTo, { expirationTtl: 600 });
        this.endStreamWhenDone = true;
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error('[turn]', e?.message || e);
    } finally {
      clearInterval(watchdog);
      this.endTurn(turn);
    }
  }

  // runTurn() skips its per-turn D1 transcript write when a call cache is in
  // play; this is the one write for the call.
  private async flushTranscript(): Promise<void> {
    await this.flushNotice();
    if (this.transcriptFlushed || !this.session || this.cache.history.length === 0) return;
    this.transcriptFlushed = true;
    try {
      await saveTranscript(this.env, {
        callSid: this.callSid,
        customerIdHashed: this.session.sub,
        businessType: this.session.businessType,
        turns: this.cache.history,
        metrics: this.metrics,
      });
    } catch (e: any) {
      console.error('[transcript flush]', e?.message || e);
    }
  }

  // Audit trail: the notice was played, and whether the caller heard it to
  // the end (Twilio reached its mark) or talked over it / hung up.
  private async flushNotice(): Promise<void> {
    const n = this.notice;
    if (!n || n.recorded || !this.session) return;
    n.recorded = true;
    await recordConsent(this.env, {
      businessType: this.session.businessType,
      channel: 'voice',
      callSid: this.callSid,
      customerIdHashed: this.session.sub,
      noticeText: n.text,
      playedAt: n.startedAt,
      heardFully: n.chunk.played,
    });
  }

  // One usage record per call: AI-handled minutes (stream start → end; a
  // transfer to staff stops the meter) plus estimated provider usage.
  private async flushUsage(): Promise<void> {
    if (this.usageFlushed || !this.session || !this.streamStartedAt) return;
    this.usageFlushed = true;
    const endedAt = Date.now();
    const seconds = (endedAt - this.streamStartedAt) / 1000;
    await recordUsage(this.env, {
      businessType: this.session.businessType,
      channel: 'voice',
      provider: this.telephony.provider,
      sttProvider: this.voice.sttProvider,
      ttsProvider: this.voice.ttsProvider,
      sourceId: this.callSid,
      startedAt: Math.floor(this.streamStartedAt / 1000),
      endedAt: Math.floor(endedAt / 1000),
      durationSeconds: seconds,
      sttSeconds: seconds, // all caller audio is streamed to STT
      ttsChars: this.meter.ttsChars,
      llmModel: this.meter.llmModel,
      llm: this.meter.llm,
      // svt/ synthetic callers (see /admin/stream-token) are metered for cost but never billed.
      billable: !this.session.sub.startsWith('synthetic-latency-test'),
    });
  }

  private callerActive() {
    if (this.quietSince) this.quietSince = Date.now();
    this.silencePrompts = 0;
    // They spoke during the goodbye — stay on the line.
    this.hangupWhenDone = false;
  }

  // Runs on every inbound media frame (every 20 ms), so no timer is needed.
  private checkSilence() {
    if (!this.quietSince) return;
    const now = Date.now();
    if (this.agentActive) { this.quietSince = now; return; }
    if (this.endStreamWhenDone) {
      this.endStreamWhenDone = false;
      this.quietSince = 0;
      console.log(`[call] ${this.callSid.slice(-8)} handing off to staff`);
      this.stt.close();
      this.ctx.waitUntil(this.flushTranscript());
      this.ctx.waitUntil(this.flushUsage());
      if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1000, 'transfer');
      return;
    }
    if (this.hangupWhenDone) {
      // Goodbye has finished playing.
      this.hangupWhenDone = false;
      this.quietSince = 0;
      console.log(`[call] ${this.callSid.slice(-8)} hanging up after caller silence`);
      this.stt.close();
      this.ctx.waitUntil(this.flushTranscript());
      this.ctx.waitUntil(this.flushUsage());
      if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1000, 'caller silent');
      return;
    }
    if (now - this.quietSince < (numEnv(this.env.VOICE_SILENCE_REPROMPT_MS) ?? SILENCE_REPROMPT_MS)) return;
    this.quietSince = now;
    if (this.silencePrompts++ === 0) {
      this.speakCanned([this.lines.stillThere]);
    } else {
      this.speakCanned([this.lines.goodbye(this.cache.sectorMeta?.name)]);
      this.hangupWhenDone = true;
    }
  }

  // Fixed lines that aren't part of the model's history (re-prompts). Spoken
  // as a greeting-style turn, so the caller can talk over them.
  private speakCanned(lines: string[]) {
    const turn = this.startTurn(true);
    const { signal } = turn.abort;
    let chain = Promise.resolve();
    for (const text of lines) {
      const chunk: SpokenChunk = { text, played: false, filler: false };
      turn.chunks.push(chunk);
      const started = this.ttsProvider.start(text, signal).catch(() => null);
      chain = chain.then(() => this.playChunk(turn, chunk, started));
    }
    chain
      .catch(e => { if (e?.name !== 'AbortError') console.error('[canned]', e?.message || e); })
      .finally(() => this.endTurn(turn));
  }

  private greet(businessType: string | undefined, sectorPromise: Promise<SectorMeta | null>) {
    // The greeting is a turn of its own so a caller who talks over it
    // actually cuts it off. It isn't part of the model's history.
    // A greeting saved in the admin UI (Settings → admin_config:<business>
    // in KV, see routes/admin.ts) replaces the built-in one.
    const savedGreeting = businessType
      ? this.env.CACHE.get(`admin_config:${businessType}`)
          .then(raw => {
            const cfg = raw ? JSON.parse(raw) as { greeting?: string; agentName?: string } : null;
            return cfg?.greeting?.trim() ? { greeting: cfg.greeting.trim(), agentName: cfg.agentName?.trim() ?? '' } : null;
          })
          .catch(() => null)
      : Promise.resolve(null);
    const turn = this.startTurn(true);
    const { signal } = turn.abort;
    const speak = (text: string, started?: Promise<Response | null>) => {
      const chunk: SpokenChunk = { text, played: false, filler: false };
      turn.chunks.push(chunk);
      return { chunk, done: this.playChunk(turn, chunk, started ?? this.ttsProvider.start(text, signal).catch(() => null)) };
    };
    const say = (text: string, started?: Promise<Response | null>) => speak(text, started).done;
    // Opener first (no dependency on the lookup), then the part that needs
    // the business name. The opener is synthesized in the default voice
    // before the business's voice settings are known; if by the time its
    // audio is ready the business turned out to use another voice
    // (applyVoice ran), it's dropped and said in that voice instead.
    const startVoice = this.voice;
    let openerDropped = false;
    const opener = this.lines.opener;
    const openerAudio = this.ttsProvider.start(opener, signal).catch(() => null).then(async (res) => {
      if (this.voice === startVoice) return res;
      openerDropped = true;
      await res?.body?.cancel().catch(() => {});
      return null;
    });
    say(opener, openerAudio)
      .then(async () => {
        if (signal.aborted) return;
        const [sectorMeta, custom] = await Promise.all([sectorPromise, savedGreeting]);
        if (signal.aborted) return;
        const lines = this.lines;
        // AI / transcription notice (DPDP), before anything else is said, in
        // the business's voice language. Off unless the business has it on —
        // see services/disclosure.ts.
        const notice = callStartNotice(sectorMeta);
        if (notice) {
          const { chunk, done } = speak(openerDropped ? `${lines.opener} ${notice}` : notice);
          this.notice = { text: notice, startedAt: new Date(), chunk, recorded: false };
          openerDropped = false;
          await done;
          if (signal.aborted) return;
        }
        const storeName = sectorMeta?.name ?? businessType ?? 'us';
        // The business's assistant name (sectors.assistant_name, default
        // Avery); a name saved with an older custom greeting still wins there.
        const name = assistantNameOf(sectorMeta);
        const body = custom
          ? lines.customGreeting(custom.greeting, custom.agentName || name)
          : lines.greeting(storeName, lines.capabilityHint(businessType, getVertical(sectorMeta).key), name);
        await say(openerDropped ? `${lines.opener} ${body}` : body);
      })
      .catch(e => { if (e?.name !== 'AbortError') console.error('[greeting]', e?.message || e); })
      .finally(() => this.endTurn(turn));
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    const ev = this.telephony.parse(message);
    if (!ev) return;   // connected, dtmf, unparseable

    if (ev.type === 'media') {
      // Always forward — even while the assistant speaks — so STT can detect barge-in.
      this.stt.sendAudio(ev.audio.buffer.slice(ev.audio.byteOffset, ev.audio.byteOffset + ev.audio.byteLength) as ArrayBuffer);
      this.checkSilence();

    } else if (ev.type === 'mark') {
      // The carrier reached this point in playback.
      const chunk = this.pendingMarks.get(ev.name);
      if (chunk) {
        chunk.played = true;
        this.pendingMarks.delete(ev.name);
        if (this.pendingMarks.size === 0) this.lastAudioEndAt = Date.now();
      }

    } else if (ev.type === 'start') {
      this.callStartedAt = Date.now();
      this.streamStartedAt = this.callStartedAt;
      this.callSid = ev.start.callSid;
      this.cache.callSid = this.callSid;
      console.log(`[call] ${this.callSid.slice(-8)}${this.telephony.provider === 'twilio' ? '' : ` (${this.telephony.provider})`}`);

      const auth = await this.authenticate(ev.start);
      if ('rejected' in auth) { this.reject(auth.rejected); return; }
      const { businessType, callerHash, callerPhone } = auth;

      this.startStt();
      this.session = buildDefaultTwilioSession(this.env, businessType) ?? undefined;
      if (this.session && callerHash) this.session.sub = callerHash;
      if (this.session && callerPhone) this.session.callerPhone = callerPhone;
      const session = this.session;

      // Kick the sector lookup off, but don't block the greeting on it.
      const sectorPromise = businessType
        ? getSector(this.env, businessType).catch(() => null)
        : Promise.resolve(null);
      sectorPromise.then(m => { if (m) this.cache.sectorMeta = m; });
      // Hindi / Sarvam businesses switch provider here (no-op for the default).
      this.voiceReady = sectorPromise.then(m => this.applyVoice(resolveVoiceSettings(m)));

      this.greet(businessType, sectorPromise);
      this.quietSince = Date.now();

      // Everything the first turn needs, fetched while the greeting plays:
      // catalog (for the business profile), the caller's account and
      // bookings, the booked-slot set and calendar busy times.
      if (session && businessType && businessType !== 'health_nav') {
        getProducts(this.env, businessType)
          .then(p => { if (!this.cache.productsAll) this.cache.productsAll = p; })
          .catch(e => console.error('[products prefetch]', e?.message || e));
        getOrders(this.env, session.sub, businessType)
          .then(o => { if (!this.cache.ordersLoaded) { this.cache.orders = o; this.cache.ordersLoaded = true; } })
          .catch(e => console.error('[orders prefetch]', e?.message || e));
        if (callerHash) {
          getOrCreateCustomer(this.env, callerHash)
            .then(account => { session.account = account; })
            .catch(e => console.error('[customer prefetch]', e?.message || e));
        }
        getBookedDatetimes(this.env, businessType)
          .then(s => { this.cache.bookedDatetimes = s; })
          .catch(e => console.error('[bookedDatetimes prefetch]', e?.message || e));
        getCalendarBusy(this.env, businessType)
          .then(b => { if (b) this.cache.calendarBusy = b; })
          .catch(e => console.error('[calendarBusy prefetch]', e?.message || e));
      }

    } else if (ev.type === 'stop') {
      this.stt.close();
      this.ctx.waitUntil(this.flushTranscript());
      this.ctx.waitUntil(this.flushUsage());
    }
  }

  // The WebSocket itself is unauthenticated; a credential minted by a
  // signature-checked webhook proves the stream came from a real inbound call
  // and says which business answers it. Outside production a missing
  // credential is tolerated so scripts/simulate-call.mjs keeps working.
  //
  //   Twilio — JWT streamToken in the start event's customParameters
  //            (minted by /twilio/inbound).
  //   Exotel — compact ?t= token bound to this call_sid (minted by
  //            /exotel/voicebot), or a static stream URL whose Basic auth the
  //            route already checked; the business then comes from the called
  //            number. The caller is the start event's `from`.
  //   Plivo  — JWT ?token= on the stream URL (minted by /plivo/answer).
  private async authenticate(start: CallStart): Promise<
    { businessType?: string; callerHash?: string; callerPhone?: string } | { rejected: string }
  > {
    const provider = this.telephony.provider;
    const params = start.params;

    if (provider === 'exotel') {
      const country = PROVIDER_COUNTRY.exotel;
      let businessType: string | undefined;
      let from = start.from;
      if (this.urlToken) {
        const claims = await verifyCompactStreamToken(this.env, this.urlToken);
        if (!claims) return { rejected: 'invalid stream token' };
        if (claims.callSid !== start.callSid) return { rejected: 'stream token is for another call' };
        businessType = claims.businessType;
        from = claims.from ?? from;
      } else if (this.preauthenticated || !isProduction(this.env)) {
        businessType = (await businessForNumber(this.env, 'exotel', start.to))
          ?? this.env.EXOTEL_DEFAULT_BUSINESS_TYPE
          ?? (isProduction(this.env) ? undefined : params.businessType ?? this.urlBusinessType);
        if (!businessType) return { rejected: `no business for ${start.to ?? 'unknown number'}` };
      } else {
        return { rejected: 'missing stream token' };
      }
      const id = await callerIdentity(from, start.callSid || crypto.randomUUID(), customerHashSalt(this.env), (raw) => normalizeE164(raw, country));
      return { businessType, ...id };
    }

    const token = provider === 'plivo' ? this.urlToken ?? params.streamToken : params.streamToken;
    if (token) {
      const claims = await verifyStreamToken(this.env, token);
      if (!claims) return { rejected: 'invalid stream token' };
      return claims;
    }
    if (isProduction(this.env)) return { rejected: 'missing stream token' };
    return { businessType: params.businessType ?? this.urlBusinessType };
  }

  private reject(reason: string) {
    console.warn(`[call] ${this.callSid.slice(-8)} rejected: ${reason}`);
    this.stt.close();
    if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1008, 'Unauthorized');
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    this.active?.abort.abort();
    this.stt.close();
    this.ctx.waitUntil(this.flushTranscript());
    this.ctx.waitUntil(this.flushUsage());
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
    console.error(`[${this.telephony.provider} ws]`, (error as any)?.message || error);
  }
}

/**
 * What the stream route told CallRelay about an upgrade request: the
 * carrier protocol (PROVIDER_HEADER, set by /twilio|exotel|plivo/stream,
 * which overwrite anything the client sent), a credential carried in the URL
 * (Exotel ?t=, Plivo ?token=), and whether the route already authenticated
 * the socket (Exotel static URL with Basic auth).
 */
export function streamConfig(request: Request): { provider: TelephonyProvider; urlToken?: string; preauthenticated: boolean } {
  const url = new URL(request.url);
  const header = request.headers.get(PROVIDER_HEADER);
  const provider: TelephonyProvider = isTelephonyProvider(header) ? header : 'twilio';
  const urlToken = provider === 'exotel' ? url.searchParams.get('t') ?? undefined
    : provider === 'plivo' ? url.searchParams.get('token') ?? undefined
    : undefined;
  return { provider, urlToken, preauthenticated: provider === 'exotel' && request.headers.get(PREAUTH_HEADER) === '1' };
}

export function joinUtterances(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(' ');
}

function numEnv(v: string | undefined): number | undefined {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
