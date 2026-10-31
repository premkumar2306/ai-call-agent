import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionPayload } from '../types';
import { buildDefaultTwilioSession } from '../middleware';
import { runTurn, amendInterruptedReply } from '../services/turn.service';
import { getSector } from '../services/sector.service';
import { getProducts } from '../services/catalog.service';
import { getOrders } from '../services/order.service';
import { getBookedDatetimes } from '../services/tool-router.service';
import { getCalendarBusy } from '../services/calendar';
import { saveTranscript } from '../services/transcript.service';
import { createCallCache, transferKey, type CallCache } from '../services/call-context';
import { createDeepgramSTT, isBackchannel, isDiscourseOnly, isEchoOf, type Stt } from './stt-deepgram';
import { verifyStreamToken } from '../utils/stream-token';
import { getOrCreateCustomer } from '../utils/identity';
import { isProduction } from '../config';
import { cartesiaStart, cartesiaDrain, type CartesiaConfig } from './tts-cartesia';

// One CallRelay instance per phone call: Twilio Media Streams → Deepgram STT
// → runTurn() → Cartesia TTS, with barge-in.
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

const FILLERS = ['One moment.', 'Let me check.', 'Just a second.'];
const STILL_WORKING = ['Still checking, thanks for waiting.', 'Almost there.'];

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
}

export class CallRelay extends DurableObject<Env> {
  private twWs?: WebSocket;
  private stt: Stt = { sendAudio: () => {}, close: () => {} };
  private session?: SessionPayload;
  private urlBusinessType?: string;
  private callSid = 'relay';
  private streamSid = '';
  private transcriptFlushed = false;
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

  private get ttsConfig(): CartesiaConfig {
    return {
      apiKey: this.env.CARTESIA_API_KEY!,
      voiceId: this.env.CARTESIA_VOICE_ID,
      modelId: this.env.CARTESIA_MODEL_ID,
    };
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
    createDeepgramSTT(
      {
        apiKey: this.env.DEEPGRAM_API_KEY ?? '',
        model: this.env.DG_MODEL,
        language: this.env.DG_LANGUAGE,
        endpointingMs: numEnv(this.env.DG_ENDPOINTING_MS),
        minConfidence: numEnv(this.env.DG_MIN_CONFIDENCE),
        bargeInMinWords: numEnv(this.env.DG_BARGE_IN_MIN_WORDS),
        isEcho: (text) => this.looksLikeEcho(text),
        incompleteHoldMs: numEnv(this.env.DG_INCOMPLETE_HOLD_MS),
        debug: /^(1|true)$/i.test(this.env.DG_DEBUG ?? ''),
      },
      (text) => { this.handleTranscript(text); },
      (reason) => { this.handleSpeechStart(reason); },
    )
      .then(s => {
        // The call may already have ended while Deepgram was connecting.
        if (this.twWs?.readyState !== WebSocket.OPEN) { s.close(); return; }
        this.stt = s;
      })
      .catch((e) => {
        console.error('[stt startup]', e?.message || e);
        if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1011, 'STT startup failed');
      });
  }

  private heardText(turn: ActiveTurn): string {
    return turn.chunks.filter(c => c.played && !c.filler).map(c => c.text).join(' ');
  }

  // Stops the assistant: aborts generation and synthesis, and tells Twilio
  // to drop audio it has buffered but not yet played.
  private bargeIn() {
    const turn = this.active;
    if (turn && !turn.closed) {
      turn.closed = true;
      turn.abort.abort();
      // The reply was already committed in full but the caller cut the
      // audio short — rewrite history to what they actually heard.
      if (turn.committed && !turn.greeting) amendInterruptedReply(this.cache, this.heardText(turn));
    }
    this.pendingMarks.clear();
    if (this.twWs && this.twWs.readyState === WebSocket.OPEN) {
      this.twWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
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
    return isEchoOf(text, spoken);
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
    if (!this.agentActive && isDiscourseOnly(text)) {
      console.log(`[turn] holding filler words: "${text}"`);
      this.carryOver = joinUtterances(this.carryOver, text);
      return;
    }

    // "Uh huh" / "okay" while the assistant is mid-reply is the caller
    // listening, not taking the turn — unless what they've heard so far
    // asked them something, in which case "yeah" is the answer. Only played
    // audio and the chunk playing now count: a question still queued behind
    // it hasn't been asked yet.
    if (this.agentActive && isBackchannel(text)) {
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
    if (signal.aborted || !res) {
      // Nobody will read this body; release it rather than leak the stream.
      await res?.body?.cancel().catch(() => {});
      return;
    }
    const ws = this.twWs!;
    const now = Date.now();
    this.spokenLog = this.spokenLog.filter(s => now - s.at < 20_000);
    this.spokenLog.push({ text: chunk.text, at: now });
    await cartesiaDrain(res, this.streamSid, ws, signal, false);
    if (signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    const name = `m${++this.markSeq}`;
    this.pendingMarks.set(name, chunk);
    ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name } }));
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
      const started = cartesiaStart(this.ttsConfig, textToSay, signal).catch((e) => {
        if (e?.name !== 'AbortError') console.error('[cartesia start]', e?.message || e);
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
      const pool = fillers === 0 && !realChunkSeen ? FILLERS : STILL_WORKING;
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
      if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1000, 'caller silent');
      return;
    }
    if (now - this.quietSince < (numEnv(this.env.VOICE_SILENCE_REPROMPT_MS) ?? SILENCE_REPROMPT_MS)) return;
    this.quietSince = now;
    if (this.silencePrompts++ === 0) {
      this.speakCanned(['Are you still there?']);
    } else {
      const name = this.cache.sectorMeta?.name;
      this.speakCanned([`I haven't heard anything, so I'll hang up now. Thanks for calling${name ? ` ${name}` : ''}. Goodbye!`]);
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
      const started = cartesiaStart(this.ttsConfig, text, signal).catch(() => null);
      chain = chain.then(() => this.playChunk(turn, chunk, started));
    }
    chain
      .catch(e => { if (e?.name !== 'AbortError') console.error('[canned]', e?.message || e); })
      .finally(() => this.endTurn(turn));
  }

  private greet(businessType: string | undefined, sectorPromise: Promise<{ name: string } | null>) {
    const capabilityHint = businessType === 'health_nav'
      ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
      : 'I can answer questions about our services and prices, or book you in — what can I do for you?';

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
    const say = (text: string) => {
      const chunk: SpokenChunk = { text, played: false, filler: false };
      turn.chunks.push(chunk);
      return this.playChunk(turn, chunk, cartesiaStart(this.ttsConfig, text, signal).catch(() => null));
    };
    // Opener first (no dependency on the lookup), then the part that needs
    // the business name.
    say('Thanks for calling!')
      .then(async () => {
        if (signal.aborted) return;
        const [sectorMeta, custom] = await Promise.all([sectorPromise, savedGreeting]);
        if (signal.aborted) return;
        const storeName = sectorMeta?.name ?? businessType ?? 'us';
        await say(custom
          ? `${custom.greeting} I'm ${custom.agentName || 'Mogi'}, the virtual assistant.`
          : `You've reached ${storeName}. I'm Mogi, the virtual assistant. ${capabilityHint}`);
      })
      .catch(e => { if (e?.name !== 'AbortError') console.error('[greeting]', e?.message || e); })
      .finally(() => this.endTurn(turn));
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(message as string);
    } catch (e: any) {
      console.error('[twilio] invalid message', e?.message || e);
      return;
    }

    if (msg.event === 'media') {
      // Always forward — even while the assistant speaks — so STT can detect barge-in.
      const bytes = base64ToBytes(msg.media.payload);
      this.stt.sendAudio(bytes.buffer as ArrayBuffer);
      this.checkSilence();

    } else if (msg.event === 'mark') {
      // Twilio reached this point in playback.
      const chunk = this.pendingMarks.get(msg.mark?.name);
      if (chunk) {
        chunk.played = true;
        this.pendingMarks.delete(msg.mark.name);
        if (this.pendingMarks.size === 0) this.lastAudioEndAt = Date.now();
      }

    } else if (msg.event === 'start') {
      this.callStartedAt = Date.now();
      this.callSid = msg.start.callSid;
      this.cache.callSid = this.callSid;
      this.streamSid = msg.start.streamSid;
      console.log(`[call] ${this.callSid.slice(-8)}`);

      // The WebSocket itself is unauthenticated; the signed token minted by
      // /twilio/inbound (which *is* Twilio-signature-checked) proves this
      // stream came from a real inbound call. Outside production, a missing
      // token is tolerated so scripts/simulate-call.mjs keeps working.
      const params = msg.start.customParameters ?? {};
      let businessType: string | undefined;
      let callerHash: string | undefined;
      let callerPhone: string | undefined;
      if (params.streamToken) {
        const claims = await verifyStreamToken(this.env, params.streamToken);
        if (!claims) { this.reject('invalid stream token'); return; }
        businessType = claims.businessType;
        callerHash = claims.callerHash;
        callerPhone = claims.callerPhone;
      } else if (isProduction(this.env)) {
        this.reject('missing stream token');
        return;
      } else {
        businessType = params.businessType ?? this.urlBusinessType;
      }

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

    } else if (msg.event === 'stop') {
      this.stt.close();
      this.ctx.waitUntil(this.flushTranscript());
    }
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
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
    console.error('[twilio ws]', (error as any)?.message || error);
  }
}

export function joinUtterances(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(' ');
}

function numEnv(v: string | undefined): number | undefined {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
