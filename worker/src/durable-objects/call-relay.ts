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
import { missedCallFollowUp } from '../services/whatsapp-outbound';
import { callStartNotice, recordConsent } from '../services/disclosure';
import { assistantNameOf, getVertical } from '../services/verticals';
import { dtmfAction, digitsUtterance } from '../services/dtmf';
import { maxDurationLine, troubleLine } from '../services/voice-language';
import { createCallCache, transferKey, type CallCache } from '../services/call-context';
import { recordCallOutcome } from '../services/metrics';
import { CallTerminator, VERIFY_MS } from '../telephony/terminator';
import { fixPhoneNumbers, isBackchannel, isDiscourseOnly, isEchoOf, type BargeDecision, type EndInfo, type Stt } from './stt-deepgram';
import { TurnTimeline, saveTurnRows, timelineLog, toRow, MAX_HEARD, type HeardInfo, type TurnRowContext } from '../services/turn-timeline';
import { LineLevel } from '../services/line-level';
import { createStt, createTts, missingVoiceSecret, type TtsProvider } from './voice-providers';
import { DEFAULT_VOICE, isDefaultVoice, resolveVoiceSettings, sttDiffers, voiceLines, type VoiceSettings } from '../services/voice-language';
import { verifyStreamToken, verifyCompactStreamToken } from '../utils/stream-token';
import { callerIdentity, getOrCreateCustomer } from '../utils/identity';
import { customerHashSalt, isProduction, voiceModel } from '../config';
import { cartesiaDrain } from './tts-cartesia';
import {
  createTelephonyAdapter, isTelephonyProvider, PREAUTH_HEADER, PROVIDER_HEADER,
  type CallStart, type TelephonyAdapter, type TelephonyProvider,
} from '../telephony';
import { businessForNumber, normalizeE164, PROVIDER_COUNTRY } from '../services/phone-numbers';
import { UsageMeter } from '../services/billing/meter';
import { recordUsage } from '../services/billing/service';
import { sttModelFor, ttsModelFor } from '../services/voice-models';
import { installProviderMock } from '../utils/provider-mock';
import { logEvent } from '../utils/telemetry';

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

// A speech socket that drops mid-call is reopened: up to STT_RECONNECT_TRIES
// attempts (backoff 200 / 500 / 1000 ms) inside STT_RECOVER_WINDOW_MS. If the
// gap passes STT_GAP_FILLER_MS the caller hears "one moment". Past the window
// the call is handed to staff (or ended politely), never left in silence.
const STT_RECONNECT_BACKOFF_MS = [200, 500, 1000];
const STT_RECOVER_WINDOW_MS = 5000;
const STT_GAP_FILLER_MS = 1500;
// A voice chunk is requested again (backoff 200 / 500 ms) before it's given up on;
// this many chunks in a row given up on means the voice provider is down.
const TTS_RETRY_BACKOFF_MS = [200, 500];
const TTS_DOWN_AFTER = 2;

// Keypad digits are submitted as one answer after this long without a press (or on #).
const DTMF_IDLE_MS = 2500;

// Dead-air watchdog: while a turn is still working and nothing is queued
// or playing, say something after this much silence — before the first
// chunk (FILLER_GRACE_MS), or in a gap later in the turn, e.g. after "Let me
// check that." while a tool and the next model round run (GAP_FILLER_MS).
// At most MAX_FILLERS per turn; runTurn's own timeout ends the wait.
const FILLER_GRACE_MS = 1200;
const GAP_FILLER_MS = 2000;
const MAX_FILLERS = 3;

// Runaway-call guards. Every one ends the carrier leg (closing the stream
// hands the call to /<carrier>/after-stream, which answers <Hangup/>/302 unless
// a transfer was saved), so a stuck call cannot bill for an hour.
//  - silence: after SILENCE_PROMPT_MS without caller speech (assistant quiet)
//    ask "Are you still there?"; SILENCE_HANGUP_MS later ask once more; SILENCE_HANGUP_MS
//    after that (the third attempt) say goodbye and hang up.
//  - max duration: MAX_CALL_MS, then a goodbye; the line is cut
//    CAP_GRACE_MS later whatever happens.
//  - dead media: no inbound audio frame for DEAD_MEDIA_MS.
//  - stuck assistant: "speaking/thinking" for AGENT_STUCK_MS (a lost playback
//    mark) is reset, so it cannot hold the silence timer off forever.
// Business overrides: sectors.silence_prompt_sec / silence_hangup_sec / max_call_minutes.
const SILENCE_PROMPT_MS = 20_000;
const SILENCE_HANGUP_MS = 10_000;
const MAX_CALL_MS = 5 * 60_000;
const CAP_GRACE_MS = 20_000;
const DEAD_MEDIA_MS = 15_000;
const AGENT_STUCK_MS = 60_000;
const GUARD_TICK_MS = 250;
// Barge-in: a mark acknowledged this long after our clear means the carrier kept playing.
const PLAYBACK_AFTER_CLEAR_MS = 400;

export type EndReason = 'silence' | 'max_duration' | 'dead_media' | 'caller_hangup' | 'agent_hangup' | 'transfer' | 'error';

// Caller speech this soon after a reply began speaking means they hadn't
// finished their turn (a pause mid-thought ended the utterance early): the
// reply is withdrawn and their words are joined to what they say now.
const CONTINUATION_MS = 2000;

// A transcript arriving this soon after our audio stopped can still be
// that audio's echo.
const ECHO_TAIL_MS = 1500;

interface SpokenChunk { text: string; played: boolean; filler: boolean; tl?: TurnTimeline }

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
  // Latency timeline for this caller turn (not the greeting).
  tl?: TurnTimeline;
}

export class CallRelay extends DurableObject<Env> {
  // The carrier's media-stream socket (named for Twilio, the first carrier).
  private twWs?: WebSocket;
  // Ends the call for real and confirms it (REST fallback); owns the DO's single alarm.
  private term = new CallTerminator(this.ctx.storage, this.env);
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
  // Keypad digits pressed as an answer, not yet handed to the turn (services/dtmf.ts).
  private dtmfDigits = '';
  // Provider failures (STT socket drop, voice down): one recovery attempt at a time, one hand-off.
  private sttRecovering = false;
  private callFailed = false;
  private ttsFailStreak = 0;
  // cache.endCall was set: goodbye, then close. Unlike hangupWhenDone, the caller speaking doesn't cancel it.
  private endCallWhenDone = false;
  private dtmfTimer: ReturnType<typeof setTimeout> | undefined;
  private callStartedAt = Date.now();
  // Silence tracking (see SILENCE_REPROMPT_MS). quietSince is 0 until the
  // stream starts, so the timer only runs on a live call.
  private quietSince = 0;
  private silencePrompts = 0;
  private hangupWhenDone = false;
  // Guards (see MAX_CALL_MS…). endReason: the first reason recorded wins.
  private endReason?: EndReason;
  private finalized = false;
  private guardTimer?: ReturnType<typeof setInterval>;
  // Short guard timings for the e2e simulator (?guardPromptMs=…); ignored in production.
  private testGuards: { promptMs?: number; hangupMs?: number; maxMs?: number; deadMediaMs?: number; verifyMs?: number } = {};
  private lastMediaAt = 0;
  private agentBusySince = 0;
  private capDeadline = 0;
  // Barge-in diagnostics: when the caller's speech was first signalled, the last
  // non-interrupting verdict logged, and the clear the carrier still has to acknowledge.
  private utteranceSignalAt = 0;
  private lastVerdict?: BargeDecision;
  private line = new LineLevel();   // caller-line energy, for the barge-in diagnostics
  private lastSkipKey = '';
  private clearInfo?: { at: number; marks: Set<string>; acked: boolean; tl?: TurnTimeline };
  // A transfer to staff was requested: close the stream (→ /twilio/after-stream
  // dials them) once the "connecting you" line has played. Not cancelled by
  // caller speech, unlike the silence goodbye.
  private endStreamWhenDone = false;
  // What the assistant said recently and when its audio last finished, for
  // echo detection (isEchoOf).
  private spokenLog: { text: string; at: number }[] = [];
  private lastAudioEndAt = 0;
  private metrics: TurnMetric[] = [];
  // Per-turn latency timelines (services/turn-timeline.ts), written once after the call.
  private timelines: TurnTimeline[] = [];
  private timelinesFlushed = false;
  // Caller audio bytes (μ-law 8 kHz = 8000 B/s) sent to STT since the last turn began.
  private sttBytes = 0;
  // Wall clock of the first keypad digit: the sync marker for scripts/latency-from-recording.mjs.
  private syncDtmfAt: number | null = null;
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
    installProviderMock(this.env);   // e2e tests only; a no-op in production
    const url = new URL(request.url);
    // Query-string businessType is a fallback for our own synthetic test harness
    // (scripts/simulate-call.mjs), which connects with the full URL directly.
    // Twilio's real Media Streams client does not reliably forward the query
    // string from <Stream url="...">, so the 'start' event's customParameters
    // (set via <Parameter> in the TwiML) is the source of truth for real calls.
    this.urlBusinessType = url.searchParams.get('businessType') ?? undefined;
    if (!isProduction(this.env)) {
      const q = (k: string) => numEnv(url.searchParams.get(k) ?? undefined);
      this.testGuards = { promptMs: q('guardPromptMs'), hangupMs: q('guardHangupMs'), maxMs: q('guardMaxMs'), deadMediaMs: q('guardDeadMs'), verifyMs: q('guardVerifyMs') };
    }
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
  private openStt(gen: number): Promise<Stt> {
    return createStt(
      this.env,
      this.voice,
      {
        endpointingMs: numEnv(this.env.DG_ENDPOINTING_MS),
        minConfidence: numEnv(this.env.DG_MIN_CONFIDENCE),
        bargeInMinWords: numEnv(this.env.DG_BARGE_IN_MIN_WORDS),
        isEcho: (text) => this.looksLikeEcho(text),
        onBargeDecision: (d) => this.noteBargeDecision(d),
        interimBargeIn: /^(1|true)$/i.test(this.env.VOICE_BARGE_IN_ON_INTERIM ?? ''),
        // Mid-sentence speech must hold off "Are you still there?".
        onActivity: () => this.callerActive(),
        onClose: () => { if (gen === this.sttGen) this.handleSttDrop(); },
        incompleteHoldMs: numEnv(this.env.DG_INCOMPLETE_HOLD_MS),
        statementHoldMs: numEnv(this.env.DG_STATEMENT_HOLD_MS),
        debug: /^(1|true)$/i.test(this.env.DG_DEBUG ?? ''),
      },
      (text, end) => { this.handleTranscript(fixPhoneNumbers(text), end); },
      (reason) => { this.handleSpeechStart(reason); },
    );
  }

  private startStt() {
    // A restart (applyVoice) supersedes an earlier socket still connecting.
    const gen = ++this.sttGen;
    this.openStt(gen)
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

  // The speech socket dropped mid-call. Reopen it (see STT_* above); the call
  // and the carrier stream stay up meanwhile.
  private handleSttDrop() {
    if (this.sttRecovering || this.callFailed || this.twWs?.readyState !== WebSocket.OPEN) return;
    this.sttRecovering = true;
    this.stt = { sendAudio: () => {}, close: () => {} };
    const t0 = Date.now();
    console.warn(`[call] ${this.callSid.slice(-8)} speech socket dropped — reconnecting`);
    const filler = setTimeout(() => {
      if (this.sttRecovering && !this.agentActive) this.speakCanned([this.lines.fillers[0]]);
    }, STT_GAP_FILLER_MS);
    const live = () => this.twWs?.readyState === WebSocket.OPEN;
    void (async () => {
      try {
        for (const backoff of STT_RECONNECT_BACKOFF_MS) {
          await new Promise(r => setTimeout(r, backoff));
          if (!live()) return;
          const left = STT_RECOVER_WINDOW_MS - (Date.now() - t0);
          if (left <= 0) break;
          const gen = ++this.sttGen;
          const attempt = this.openStt(gen);
          // A socket that opens after we gave up on it is closed, not leaked.
          attempt.then(s => { if (gen !== this.sttGen) s.close(); }, () => {});
          try {
            const s = await Promise.race([attempt, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), left))]);
            if (!live() || gen !== this.sttGen) { s.close(); return; }
            this.stt = s;
            logEvent('info', 'call.stt_recovered', { callId: this.callSid.slice(-8), provider: this.telephony.provider, ms: Date.now() - t0 });
            return;
          } catch (e: any) {
            ++this.sttGen;   // the attempt that timed out must not become the live socket
            console.warn(`[call] speech reconnect failed: ${e?.message || e}`);
          }
        }
        if (live()) this.failCall('stt');
      } finally {
        clearTimeout(filler);
        this.sttRecovering = false;
      }
    })();
  }

  // A provider can't be recovered. Never silence: apologise and hand the call
  // to staff when the business has a line (the caller can't leave a message
  // when we can't hear them), otherwise apologise and hang up.
  // `spoken` is false when the voice itself is what failed.
  private failCall(reason: 'stt' | 'tts') {
    if (this.callFailed || this.endStreamWhenDone || this.twWs?.readyState !== WebSocket.OPEN) return;
    this.callFailed = true;
    this.endReason ??= 'error';
    logEvent('error', 'call.provider_failed', { callId: this.callSid.slice(-8), provider: this.telephony.provider, reason });
    const staff = this.cache.sectorMeta?.phone?.replace(/[^\d+]/g, '');
    const lang = this.voice.language;
    if (staff) {
      this.cache.transferTo = staff;
      this.ctx.waitUntil(this.env.CACHE.put(transferKey(this.callSid), staff, { expirationTtl: 600 }));
      this.endStreamWhenDone = true;
    } else {
      this.hangupWhenDone = true;
    }
    if (reason === 'stt') this.speakCanned([troubleLine(lang, !!staff)]);
    if (!this.quietSince) this.quietSince = Date.now();
  }

  // Switches the call to the business's voice settings once the sector
  // lookup lands. A no-op for default settings (the US business).
  private applyVoice(voice: VoiceSettings) {
    if (isDefaultVoice(voice) || this.twWs?.readyState !== WebSocket.OPEN) return;
    const missing = missingVoiceSecret(this.env, voice);
    if (missing) {
      // The owner's choice is saved, but until the secret exists the call
      // stays on the default English Deepgram/Cartesia path.
      console.warn(`[call] ${this.callSid.slice(-8)} voice config needs ${missing}; using default voice`);
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
  // carrier to drop audio it has buffered but not yet played. `cause` is why.
  private bargeIn(cause: string) {
    const now = Date.now();
    const turn = this.active;
    const first = !!turn && !turn.closed;
    if (turn && !turn.closed) {
      turn.closed = true;
      if (turn.tl) turn.tl.bargeIn = true;
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
    const marks = new Set(this.pendingMarks.keys());
    this.pendingMarks.clear();
    const sent = this.sendToCarrier(this.telephony.clear());
    if (first || marks.size) {
      const clearMs = this.utteranceSignalAt ? now - this.utteranceSignalAt : undefined;
      const b = turn?.tl?.barge;
      if (b && first) { b.interrupts++; b.reason = cause; b.clearMs = clearMs; }
      this.clearInfo = { at: now, marks, acked: false, tl: turn?.tl };
      logEvent('info', 'barge.clear', { callId: this.callSid.slice(-8), carrier: this.telephony.provider, cause, clearMs, sent, pendingMarks: marks.size, turn: turn?.id });
    }
    this.utteranceSignalAt = 0;
  }

  // The carrier acknowledged our clear: Plivo says so (clearedAudio); Twilio and
  // Exotel echo the marks of the audio they dropped. An echo long after the clear
  // means that audio kept playing.
  private clearAcked(via: string, markName?: string) {
    const ci = this.clearInfo;
    if (!ci) return;
    const ms = Date.now() - ci.at;
    if (markName) {
      if (!ci.marks.delete(markName)) return;
      if (ms > PLAYBACK_AFTER_CLEAR_MS) {
        if (ci.tl) ci.tl.barge.playedAfterClear++;
        logEvent('warn', 'barge.playback_after_clear', { callId: this.callSid.slice(-8), carrier: this.telephony.provider, ms });
      }
    }
    if (ci.acked) return;
    ci.acked = true;
    if (ci.tl) ci.tl.barge.clearAcked = true;
    logEvent('info', 'barge.clear_ack', { callId: this.callSid.slice(-8), carrier: this.telephony.provider, via, ms });
  }

  // Every verdict on recognised words heard while the assistant is speaking. Yes
  // verdicts are logged by handleSpeechStart (with the clear); the rest here, once
  // per reason per utterance so a growing interim doesn't flood the log.
  private noteBargeDecision(d: BargeDecision) {
    this.lastVerdict = d;
    if (!this.agentActive) return;
    const b = this.active?.tl?.barge;
    if (b) { b.decisions++; if (!d.interrupt && b.skipped.length < 5) b.skipped.push({ reason: d.reason, words: d.words }); }
    this.noteHeard('interim', d.interrupt, d.reason, d);
    if (d.interrupt || this.lastSkipKey === d.reason) return;
    this.lastSkipKey = d.reason;
    logEvent('info', 'barge.decision', {
      callId: this.callSid.slice(-8), carrier: this.telephony.provider, signal: 'interim', words: d.words, threshold: d.threshold,
      vad: this.vadBargeIn, echo: d.reason === 'echo', interrupt: false, reason: d.reason,
    });
  }

  // Records, for the turn's timeline, what was heard at a barge-in decision: numbers only, never the words.
  // Interim verdicts repeat as an interim grows, so a repeat of the same outcome is not stored again.
  private noteHeard(signal: HeardInfo['signal'], interrupt: boolean, reason: string, d?: BargeDecision, words?: number) {
    const b = this.active?.tl?.barge;
    if (!b || !this.agentActive) return;
    const list = (b.heard ??= []);
    const last = list[list.length - 1];
    if (list.length >= MAX_HEARD || (last && last.signal === signal && last.reason === reason && last.interrupt === interrupt)) return;
    const { noiseFloorDb, voicedMs } = this.line.snapshot();
    list.push({
      signal, interrupt, reason, words: d?.words ?? words, conf: d?.confidence !== undefined ? Math.round(d.confidence * 100) / 100 : undefined,
      voicedMs, lexicon: d?.lexicon, floorDb: noiseFloorDb, sinceSpeakMs: Date.now() - this.speakStartedAt,
    });
  }

  private get vadBargeIn(): boolean {
    return /^(1|true)$/i.test(this.env.VOICE_BARGE_IN_ON_VAD ?? '');
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
    const now = Date.now();
    if (!this.utteranceSignalAt || now - this.utteranceSignalAt > 5000 || !this.agentActive) this.utteranceSignalAt = now;
    if (!this.agentActive) return;
    const log = (interrupt: boolean, why: string, extra: Record<string, string | number | boolean | undefined> = {}) =>
      logEvent('info', 'barge.decision', {
        callId: this.callSid.slice(-8), carrier: this.telephony.provider, signal: reason, vad: this.vadBargeIn,
        interrupt, reason: why, sinceSpeakMs: now - this.speakStartedAt, ...extra,
      });
    if (reason === 'vad' && !this.vadBargeIn) { if (this.lastSkipKey !== 'vad_off') { this.lastSkipKey = 'vad_off'; log(false, 'vad_off'); this.noteHeard('vad', false, 'vad_off'); } return; }
    if (now - this.speakStartedAt < BARGE_IN_MIN_SPEAK_MS) { log(false, 'too_early'); this.noteHeard(reason === 'vad' ? 'vad' : 'interim', false, 'too_early'); return; }
    const v = reason === 'interim' ? this.lastVerdict : undefined;
    const b = this.active?.tl?.barge;
    if (b) b.decisions++;
    if (reason === 'vad') this.noteHeard('vad', true, 'vad');
    log(true, v?.reason ?? 'vad', v ? { words: v.words, threshold: v.threshold, echo: false } : {});
    this.bargeIn(v?.reason ?? 'vad');
  }

  // Our own audio coming back from a speakerphone, heard while (or just
  // after) it played.
  private looksLikeEcho(text: string): boolean {
    const now = Date.now();
    if (this.pendingMarks.size === 0 && now - this.lastAudioEndAt > ECHO_TAIL_MS) return false;
    const spoken = this.spokenLog.filter(s => now - s.at < 20_000).map(s => s.text).join(' ');
    return isEchoOf(text, spoken, this.voice.language);
  }

  // A keypad press. 0 asks for staff; digits are an answer to a number/date
  // question when the business turned dtmf_input on; the rest is ignored.
  // The decision is services/dtmf.ts; what happens next goes through the same
  // path as speech, so transfer hours, barge-in and the transcript all apply.
  private handleDtmf(digit: string) {
    if (!this.session || !this.twWs) return;
    const meta = this.cache.sectorMeta;
    const lastAssistant = [...this.spokenLog.slice(-3).map(s => s.text), ''].join(' ').trim()
      || [...this.cache.history].reverse().find(t => t.role === 'assistant')?.content || '';
    const action = dtmfAction(digit, {
      hasStaffLine: !!meta?.phone,
      inputEnabled: !!meta?.dtmfInput,
      collecting: this.dtmfDigits.length > 0,
      lastAssistantText: lastAssistant,
    });
    console.log(`[dtmf] ${digit} → ${action}`);
    if (action === 'ignore') return;
    if (this.dtmfTimer) { clearTimeout(this.dtmfTimer); this.dtmfTimer = undefined; }
    if (action === 'transfer') {
      this.dtmfDigits = '';
      this.handleTranscript("I'd like to speak to a person, please.");
      return;
    }
    if (action === 'collect') this.dtmfDigits += digit;
    if (action === 'submit' || this.dtmfDigits.length >= 15) return this.submitDtmf();
    this.callerActive();
    this.dtmfTimer = setTimeout(() => this.submitDtmf(), DTMF_IDLE_MS);
  }

  private submitDtmf() {
    if (this.dtmfTimer) { clearTimeout(this.dtmfTimer); this.dtmfTimer = undefined; }
    const digits = this.dtmfDigits;
    this.dtmfDigits = '';
    if (digits) this.handleTranscript(digitsUtterance(digits));
  }

  private handleTranscript(text: string, end?: EndInfo) {
    const finalAt = performance.now();
    if (!this.session || !this.twWs || this.endCallWhenDone) return;
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
      logEvent('info', 'barge.decision', {
        callId: this.callSid.slice(-8), carrier: this.telephony.provider, signal: 'final', words: text.trim().split(/\s+/).length,
        vad: this.vadBargeIn, interrupt: true, reason: 'transcript',
      });
      if (this.active?.tl) this.active.tl.barge.decisions++;
      this.noteHeard('final', true, 'transcript', undefined, text.trim().split(/\s+/).filter(Boolean).length);
      this.bargeIn('transcript');
    }
    this.utteranceSignalAt = 0;
    this.lastSkipKey = '';

    const gen = ++this.transcriptGen;
    const receivedAt = Date.now();
    this.turnChain = this.turnChain
      .then(() => this.runOneTurn(text, gen, receivedAt, finalAt, end))
      .catch(e => console.error('[turn chain]', e?.message || e));
  }

  // Plays one synthesized chunk and registers a mark for it. `started` is the
  // already-issued Cartesia request, so synthesis overlaps earlier playback.
  private async playChunk(turn: ActiveTurn, chunk: SpokenChunk, started: Promise<Response | null>) {
    const { signal } = turn.abort;
    let res = await started;
    // A failed synthesis request is retried, not skipped (a skipped one is a hole in the sentence).
    for (const backoff of res || signal.aborted ? [] : TTS_RETRY_BACKOFF_MS) {
      await new Promise(r => setTimeout(r, backoff));
      if (signal.aborted) break;
      res = await this.ttsProvider.start(chunk.text, signal).catch(() => null);
      if (res) break;
    }
    if (res) this.ttsFailStreak = 0;
    else if (!signal.aborted && ++this.ttsFailStreak >= TTS_DOWN_AFTER) this.failCall('tts');
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
    await cartesiaDrain(res, (audio) => {
      // The caller already cut this reply off: drop audio still arriving, never send it.
      if (turn.closed) { if (turn.tl) turn.tl.barge.ttsDropped++; return false; }
      const frames = this.telephony.audio(audio);
      const ok = this.sendToCarrier(frames);
      const tl = turn.tl;
      if (tl) {
        if (!chunk.filler) tl.once('firstTts');
        if (ok && frames.length) tl.once(chunk.filler ? 'firstFillerSent' : 'firstSent');
      }
      return ok;
    }, signal);
    if (signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    const name = `m${++this.markSeq}`;
    this.pendingMarks.set(name, chunk);
    // Adapters that buffer audio until the mark (Exotel) only write it here.
    if (this.sendToCarrier(this.telephony.mark(name)) && turn.tl) turn.tl.once(chunk.filler ? 'firstFillerSent' : 'firstSent');
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

  private async runOneTurn(text: string, gen: number, receivedAt = Date.now(), finalAt = performance.now(), end?: EndInfo): Promise<void> {
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
    const tl = new TurnTimeline(finalAt, end);
    tl.sttAudioS = this.sttBytes / 8000;
    this.sttBytes = 0;
    turn.tl = tl;
    if (this.timelines.length < 100) this.timelines.push(tl);

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
      const chunk: SpokenChunk = { text: textToSay, played: false, filler, tl };
      turn.chunks.push(chunk);
      tl.ttsChars += textToSay.length;
      if (!filler) tl.once('firstPhrase');
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
        onUsage: (model, usage) => { this.meter.addLlm(model, usage); tl.addLlm(usage); },
        onTool: (name, start, endAt, ok) => tl.tool(name, start, endAt, ok),
        // Booking side effects (calendar, staff notification) finish even if the caller hangs up mid-tool.
        background: (p) => this.ctx.waitUntil(p),
      });
      tl.outcome = metric.outcome = !result.committed ? 'dropped' : result.interrupted ? 'interrupted' : 'done';
      if (!result.committed) {
        // Caller heard nothing of the reply — keep their words for the next turn.
        this.carryOver = joinUtterances(utterance, this.carryOver);
      } else if (!result.interrupted) {
        turn.committed = true;
      }
      clearInterval(watchdog);
      await chunkChain;
      if (this.cache.endCall) this.endCallWhenDone = true;
      if (this.cache.transferTo && !this.endStreamWhenDone) {
        await this.env.CACHE.put(transferKey(this.callSid), this.cache.transferTo, { expirationTtl: 600 });
        this.endStreamWhenDone = true;
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error('[turn]', e?.message || e);
    } finally {
      clearInterval(watchdog);
      this.endTurn(turn);
      if (tl.bargeIn && tl.outcome === 'done') tl.outcome = 'interrupted';
      try { console.log(JSON.stringify({ evt: 'turn.timeline', ...timelineLog(toRow(tl, this.turnContext(this.timelines.indexOf(tl) + 1))) })); } catch { /* telemetry only */ }
    }
  }

  private turnContext(turnN: number): TurnRowContext {
    const sttProvider = this.voice.sttProvider;
    const flux = /^flux/.test(this.env.DG_MODEL ?? '');
    return {
      callSid: this.callSid, businessType: this.session?.businessType ?? '', provider: this.telephony.provider, turnN,
      sttProvider, ttsProvider: this.ttsProvider.name, llmModel: voiceModel(this.env),
      endpointingMs: sttProvider === 'sarvam' || flux ? null : numEnv(this.env.DG_ENDPOINTING_MS) ?? 250,
      syncDtmfAt: this.syncDtmfAt,
    };
  }

  // The one D1 write for the call's turn timelines; run under waitUntil, never on a turn's path.
  private async flushTurnMetrics(): Promise<void> {
    if (this.timelinesFlushed || !this.timelines.length) return;
    this.timelinesFlushed = true;
    try {
      await saveTurnRows(this.env, this.timelines.map((tl, i) => toRow(tl, this.turnContext(i + 1))));
    } catch (e: any) {
      console.error('[turn metrics flush]', e?.message || e);
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

  // Missed-call follow-up on WhatsApp (per business, off by default): the
  // caller hung up before speaking, the call was cut short, or a message was
  // taken. whatsapp-outbound.ts decides and sends; once per call.
  private followUpDone = false;
  private async flushFollowUp(): Promise<void> {
    if (this.followUpDone || !this.session || !this.streamStartedAt) return;
    this.followUpDone = true;
    const h = this.cache.history;
    try {
      await missedCallFollowUp(this.env, {
        businessType: this.session.businessType,
        callSid: this.callSid,
        callerPhone: this.session.callerPhone,
        phoneHash: this.session.sub,
        startedAtSec: Math.floor(this.streamStartedAt / 1000),
        userTurns: h.filter(t => t.role === 'user').length,
        lastRole: (h.at(-1)?.role as 'user' | 'assistant' | undefined) ?? null,
        durationSec: (Date.now() - this.streamStartedAt) / 1000,
        messageTaken: !!this.cache.messageId,
        transferred: !!this.cache.transferTo,
      });
    } catch (e: any) {
      console.error('[follow-up]', e?.message || e);
    }
    // Pilot metrics: one outcome row per call (telemetry; never throws).
    await recordCallOutcome(this.env, {
      carrier: this.telephony.provider, callSid: this.callSid, businessType: this.session.businessType,
      callerHash: this.session.sub, startedAt: Math.floor(this.streamStartedAt / 1000), endedAt: Math.floor(Date.now() / 1000),
      userTurns: h.filter(t => t.role === 'user').length, transferred: !!this.cache.transferTo, messageTaken: !!this.cache.messageId,
      isTest: this.session.sub.startsWith('synthetic-'),
      endReason: this.endReason ?? 'caller_hangup',
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
      sttModel: sttModelFor(this.env, this.voice.sttProvider, this.voice.language),
      ttsModel: ttsModelFor(this.env, this.voice.ttsProvider),
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

  private get guards() {
    const m = this.cache.sectorMeta;
    return {
      promptMs: this.testGuards.promptMs ?? (m?.silencePromptSec ? m.silencePromptSec * 1000 : numEnv(this.env.VOICE_SILENCE_REPROMPT_MS) ?? SILENCE_PROMPT_MS),
      hangupMs: this.testGuards.hangupMs ?? (m?.silenceHangupSec ? m.silenceHangupSec * 1000 : numEnv(this.env.VOICE_SILENCE_HANGUP_MS) ?? SILENCE_HANGUP_MS),
      maxMs: this.testGuards.maxMs ?? (m?.maxCallMinutes ? m.maxCallMinutes * 60_000 : numEnv(this.env.VOICE_MAX_CALL_MS) ?? MAX_CALL_MS),
      deadMediaMs: this.testGuards.deadMediaMs ?? numEnv(this.env.VOICE_DEAD_MEDIA_MS) ?? DEAD_MEDIA_MS,
      verifyMs: this.testGuards.verifyMs ?? numEnv(this.env.VOICE_HANGUP_VERIFY_MS) ?? VERIFY_MS,
    };
  }

  // Writes the call's records once and stops its timers. Safe to call from every
  // way a call can end; the first end reason recorded stands.
  private finalize(reason: EndReason) {
    this.endReason ??= reason;
    if (this.guardTimer) { clearInterval(this.guardTimer); this.guardTimer = undefined; }
    if (this.dtmfTimer) { clearTimeout(this.dtmfTimer); this.dtmfTimer = undefined; }
    if (this.finalized) return;
    this.finalized = true;
    this.quietSince = 0;
    this.stt.close();
    this.ctx.waitUntil(this.flushTranscript());
    this.ctx.waitUntil(this.flushTurnMetrics());
    this.ctx.waitUntil(this.flushUsage());
    this.ctx.waitUntil(this.flushFollowUp());
    // Verify the carrier really ended the call (and hang it up by REST if not).
    this.ctx.waitUntil(this.term.request(this.endReason ?? reason).catch(e => console.error('[terminator]', e?.message || e)));
  }

  // Ends the carrier leg: closing the stream moves the carrier on to
  // /<carrier>/after-stream, which hangs up (or dials staff when a transfer was saved).
  private hangUp(reason: EndReason, closeReason: string) {
    logEvent('warn', 'call.hangup', {
      callId: this.callSid.slice(-8), provider: this.telephony.provider, reason,
      seconds: Math.round((Date.now() - this.streamStartedAt) / 1000),
    });
    this.finalize(reason);
    this.active?.abort.abort();
    // After an eviction twWs is gone but the hibernated sockets are still ours to close.
    for (const ws of this.twWs ? [this.twWs] : this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, closeReason);
    }
  }

  // Runs every GUARD_TICK_MS from the start of the stream (a timer, not the media
  // frames: a stalled carrier sends none, and a stuck "assistant is speaking"
  // used to hold the silence timer off for as long as the carrier kept the line).
  private guardTick() {
    if (this.finalized || !this.streamStartedAt) return;
    const now = Date.now();
    const g = this.guards;
    if (this.lastMediaAt && now - this.lastMediaAt > g.deadMediaMs) return this.hangUp('dead_media', 'no audio from carrier');
    if (this.capDeadline && now > this.capDeadline) return this.hangUp('max_duration', 'max duration');
    if (!this.capDeadline && now - this.streamStartedAt > g.maxMs) this.startCap();

    if (!this.quietSince) return;
    if (this.agentActive) {
      this.quietSince = now;
      this.agentBusySince ||= now;
      if (now - this.agentBusySince > AGENT_STUCK_MS) {
        logEvent('warn', 'call.agent_stuck_reset', { callId: this.callSid.slice(-8), provider: this.telephony.provider, pendingMarks: this.pendingMarks.size, turnInFlight: this.turnInFlight });
        this.active?.abort.abort();
        this.pendingMarks.clear();
        this.turnInFlight = false;
        this.agentBusySince = 0;
      }
      return;
    }
    this.agentBusySince = 0;
    if (this.endStreamWhenDone) {
      this.endStreamWhenDone = false;
      console.log(`[call] ${this.callSid.slice(-8)} handing off to staff`);
      this.hangUp('transfer', 'transfer');
      return;
    }
    if (this.endCallWhenDone) {
      // The goodbye has finished playing; end the call and finalise once.
      this.endCallWhenDone = false;
      console.log(`[call] ${this.callSid.slice(-8)} ending call (endCall)`);
      this.hangUp('agent_hangup', 'call ended');
      return;
    }
    if (this.hangupWhenDone) {
      // Goodbye has finished playing.
      this.hangupWhenDone = false;
      console.log(`[call] ${this.callSid.slice(-8)} hanging up after caller silence`);
      this.hangUp('silence', 'caller silent');
      return;
    }
    if (now - this.quietSince < (this.silencePrompts === 0 ? g.promptMs : g.hangupMs)) return;
    this.quietSince = now;
    if (this.silencePrompts++ < 2) {
      logEvent('info', 'call.silence_prompt', { callId: this.callSid.slice(-8), provider: this.telephony.provider, nudge: this.silencePrompts });
      this.speakCanned([this.lines.stillThere]);
    } else {
      this.speakCanned([this.lines.goodbye(this.cache.sectorMeta?.name)]);
      this.hangupWhenDone = true;
    }
  }

  // The call hit its maximum length: say so and end it (or hand it to staff when
  // the caller was talking just now); the line is cut CAP_GRACE_MS later regardless.
  private startCap() {
    this.capDeadline = Date.now() + CAP_GRACE_MS;
    this.endReason ??= 'max_duration';
    logEvent('warn', 'call.max_duration', { callId: this.callSid.slice(-8), provider: this.telephony.provider });
    this.active?.abort.abort();
    this.pendingMarks.clear();
    this.sendToCarrier(this.telephony.clear());
    this.endCallWhenDone = true;
    this.speakCanned([maxDurationLine(this.voice.language, false)]);
  }

  // Backstop if the timers never ran (the object was evicted mid-call): cut any open stream.
  // One alarm per DO: CallTerminator multiplexes the backstop, the hang-up check and the re-check.
  async alarm() {
    const r = await this.term.onAlarm();
    if (r === 'backstop') this.hangUp('max_duration', 'max duration (alarm)');
    else if (r === 'none') for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'max duration (alarm)');
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
      this.lastMediaAt = Date.now();
      this.sttBytes += ev.audio.byteLength;
      this.line.push(ev.audio);
      this.stt.sendAudio(ev.audio.buffer.slice(ev.audio.byteOffset, ev.audio.byteOffset + ev.audio.byteLength) as ArrayBuffer);
      this.guardTick();   // also on every frame, so a goodbye or hand-off ends the stream as promptly as it always did

    } else if (ev.type === 'mark') {
      // The carrier reached this point in playback.
      this.clearAcked('mark', ev.name);
      const chunk = this.pendingMarks.get(ev.name);
      if (chunk) {
        chunk.played = true;
        // Carrier-confirmed: the last real chunk's echo wins (marks echo in order).
        if (chunk.tl && !chunk.filler) chunk.tl.stamps.playbackDone = chunk.tl.rel();
        this.pendingMarks.delete(ev.name);
        if (this.pendingMarks.size === 0) this.lastAudioEndAt = Date.now();
      }

    } else if (ev.type === 'cleared') {
      this.clearAcked('clearedAudio');

    } else if (ev.type === 'start') {
      this.callStartedAt = Date.now();
      this.streamStartedAt = this.callStartedAt;
      this.lastMediaAt = this.callStartedAt;
      if (!this.guardTimer) this.guardTimer = setInterval(() => this.guardTick(), GUARD_TICK_MS);
      this.callSid = ev.start.callSid;
      // Persisted, so the max-duration backstop and the hang-up check survive an eviction.
      this.ctx.waitUntil(this.term.start(this.callSid, this.telephony.provider, this.callStartedAt + this.guards.maxMs + CAP_GRACE_MS + 30_000, this.guards.verifyMs).catch(() => {}));
      this.cache.callSid = this.callSid;
      logEvent('info', 'call.stream_started', {
        callId: this.callSid.slice(-8),
        provider: this.telephony.provider,
      });

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

    } else if (ev.type === 'dtmf') {
      this.syncDtmfAt ??= Date.now();
      this.handleDtmf(ev.digit);

    } else if (ev.type === 'stop') {
      this.finalize('caller_hangup');
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
    logEvent('warn', 'call.rejected', {
      callId: this.callSid.slice(-8),
      provider: this.telephony.provider,
      reason,
    });
    this.stt.close();
    if (this.guardTimer) { clearInterval(this.guardTimer); this.guardTimer = undefined; }
    if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1008, 'Unauthorized');
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    this.active?.abort.abort();
    this.finalize('caller_hangup');
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
    logEvent('error', 'call.websocket_error', {
      callId: this.callSid.slice(-8),
      provider: this.telephony.provider,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
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
