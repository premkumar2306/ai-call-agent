import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionPayload } from '../types';
import { buildDefaultTwilioSession } from '../middleware';
import { runTurn } from '../services/turn.service';
import { getSector } from '../services/sector.service';
import { getBookedDatetimes } from '../services/tool-router.service';
import { saveTranscript } from '../services/transcript.service';
import { createCallCache, type CallCache } from '../services/call-context';
import { createDeepgramSTT, type Stt } from './stt-deepgram';
import { verifyStreamToken } from '../utils/stream-token';
import { isProduction } from '../config';
import { cartesiaStart, cartesiaDrain, type CartesiaConfig } from './tts-cartesia';

// One CallRelay instance per phone call. Ported from relay/relay.js's per-connection
// WebSocket handler (Twilio Media Streams → Deepgram STT → runTurn() → Cartesia TTS),
// with barge-in (interrupt TTS when the caller starts talking again) preserved.
//
// ElevenLabs STT and macOS `say` TTS from relay.js are intentionally not ported —
// neither is Workers-compatible (Node SDK / child_process). relay.js stays as a
// local-dev-only fallback for those.

const FILLERS = ['One moment...', 'Let me check that for you...', 'Almost there...'];

// Don't honour a barge-in within this long of the assistant starting to
// speak. Guards against the leading edge of our own audio echoing back on a
// speakerphone and instantly cutting off the reply we just began.
const BARGE_IN_MIN_SPEAK_MS = 300;

// How eagerly the assistant stops talking when it hears something.
//
//   final   — only once Deepgram has finalized an utterance. The behaviour
//             before #12. Slowest to react (the caller talks over the
//             assistant for their whole utterance plus endpointing) but it
//             cannot be fooled by noise.
//   interim — on the first interim transcript that looks like real words.
//             Much faster, and requires Deepgram to have actually recognised
//             speech rather than merely detected sound.
//   vad     — on Deepgram's SpeechStarted, the earliest possible signal.
//
// Default is `final`. #12 shipped `vad` as the default and that was wrong for
// a PSTN line: Twilio does not echo-cancel the inbound track against what we
// play, so the assistant's own voice comes back up the caller's handset,
// trips VAD, and aborts the greeting — dead air. `vad` and `interim` are
// worth enabling once a line is known to behave, which is what the env knob
// is for; they are not safe as an unverified default.
type BargeInMode = 'final' | 'interim' | 'vad';

function bargeInMode(env: Env): BargeInMode {
  const raw = (env.VOICE_BARGE_IN_MODE ?? '').trim().toLowerCase();
  if (raw === 'final' || raw === 'interim' || raw === 'vad') return raw;
  // Back-compat with the boolean this replaced: VOICE_BARGE_IN_ON_VAD=0 meant
  // "wait for interim text instead of raw VAD".
  if (/^(0|false)$/i.test(env.VOICE_BARGE_IN_ON_VAD ?? '')) return 'interim';
  if (/^(1|true)$/i.test(env.VOICE_BARGE_IN_ON_VAD ?? '')) return 'vad';
  return 'final';
}

// Short words people actually interrupt with. Without these the length rule
// below would ignore "wait" and "stop" — the most common real barge-ins —
// while still reacting to a stray "um".
const INTERRUPTION_WORDS = new Set([
  'wait', 'stop', 'no', 'nope', 'hold', 'sorry', 'hey', 'hello', 'yes', 'yeah',
  'nah', 'what', 'huh', 'pardon', 'cancel', 'wrong', 'help',
]);

/**
 * Whether an interim transcript is substantial enough to be worth cutting the
 * assistant off for. A single recognised fragment is as likely to be a cough
 * or a clipped echo as it is the caller interrupting.
 *
 * This is a filter, not a guarantee. It cannot separate the caller from the
 * assistant's own voice returning up the handset, because an echo of our own
 * multi-word speech passes any word-count test. That is why `interim` is not
 * the default barge-in mode — only why it is usable at all on a line that
 * doesn't echo badly.
 */
export function isSubstantialSpeech(text: string | undefined): boolean {
  if (!text) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  if (words.length !== 1) return false;
  const word = words[0].toLowerCase().replace(/[^a-z']/g, '');
  // A long word ("appointment") or a known interjection ("wait").
  return word.length >= 6 || INTERRUPTION_WORDS.has(word);
}

export class CallRelay extends DurableObject<Env> {
  private twWs?: WebSocket;
  private stt: Stt = { sendAudio: () => {}, close: () => {} };
  private session?: SessionPayload;
  private urlBusinessType?: string;
  private callSid = 'relay';
  private streamSid = '';
  private busy = false;
  private currentAbort?: AbortController;
  private speakStartedAt = 0;
  private transcriptFlushed = false;
  // Call-lifetime cache: sector metadata, product list, tool defs, history,
  // orders and booked-slot set all live here instead of round-tripping to
  // KV/D1 on every turn. See issue #7 / worker/src/services/call-context.ts.
  private cache: CallCache = createCallCache();

  private get ttsConfig(): CartesiaConfig {
    return {
      apiKey: this.env.CARTESIA_API_KEY!,
      voiceId: this.env.CARTESIA_VOICE_ID,
      modelId: this.env.CARTESIA_MODEL_ID,
    };
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
        debug: /^(1|true)$/i.test(this.env.DG_DEBUG ?? ''),
      },
      (text) => { this.handleTranscript(text); },
      (reason, text) => { this.handleSpeechStart(reason, text); },
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

  private bargeIn() {
    if (this.currentAbort) { this.currentAbort.abort(); this.currentAbort = undefined; }
    if (this.twWs && this.twWs.readyState === WebSocket.OPEN) {
      this.twWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
    this.busy = false;
  }

  // Fired the moment Deepgram reports speech — before any transcript exists.
  // This is what makes barge-in feel immediate: previously barge-in was
  // triggered from handleTranscript(), i.e. only once the caller had finished
  // their whole utterance and endpointing had elapsed, so the assistant
  // talked over them for the entire interruption plus ~200ms.
  //
  // `reason` is 'vad' (Deepgram's SpeechStarted — earliest) or 'interim' (the
  // first interim transcript — later, but it took real recognised words to
  // get there). Set VOICE_BARGE_IN_ON_VAD=0 to wait for 'interim' on lines
  // where raw VAD proves too trigger-happy.
  private handleSpeechStart(reason: 'vad' | 'interim', text?: string) {
    if (!this.busy) return;

    const mode = bargeInMode(this.env);
    // `final` leaves barge-in entirely to handleTranscript(), as before #12.
    if (mode === 'final') return;
    if (mode === 'interim' && reason !== 'interim') return;
    if (Date.now() - this.speakStartedAt < BARGE_IN_MIN_SPEAK_MS) return;
    // Raw VAD carries no transcript to weigh, which is exactly why it is not
    // the default. On interim we have words, so insist they look like speech.
    if (reason === 'interim' && !isSubstantialSpeech(text)) return;

    console.log(`[barge-in] speech-start (${reason}, mode=${mode}) "${(text ?? '').slice(0, 40)}" — stopping TTS`);
    this.bargeIn();
  }

  private async speak(text: string, signal?: AbortSignal, sendMark: boolean = true): Promise<void> {
    console.log(`[tts] "${text}"`);
    const t0 = Date.now();
    const res = await cartesiaStart(this.ttsConfig, text, signal).catch((e) => {
      if (e?.name !== 'AbortError') console.error('[cartesia start]', e?.message || e);
      return null;
    });
    await cartesiaDrain(res, this.streamSid, this.twWs!, signal, sendMark);
    console.log(`[tts] ⏱ "${text.slice(0, 20)}": ${Date.now() - t0}ms`);
  }

  private async handleTranscript(text: string) {
    if (!this.session || !this.twWs) return;

    if (this.busy) {
      // Normally handleSpeechStart() already aborted the previous turn well
      // before this point; this stays as a backstop for the case where no
      // speech-start signal arrived (e.g. vad barge-in disabled and the
      // utterance finalized straight off a speech_final).
      console.log(`[barge-in] on transcript "${text.slice(0, 40)}"`);
      this.bargeIn();
    }

    this.busy = true;
    this.speakStartedAt = Date.now();
    const ac = new AbortController();
    this.currentAbort = ac;
    const { signal } = ac;
    const tag = this.callSid.slice(-8);
    const t0 = Date.now();

    // Chunks stream in from runTurn() as they become ready. Synthesis for a
    // chunk is kicked off the instant it arrives, so its TTFB overlaps with
    // whatever is still playing; only the *draining* to Twilio is chained, so
    // audio stays strictly sequential and barge-in (via `signal`) stops the
    // sequence cleanly instead of continuing to speak already-queued chunks.
    let chunkChain: Promise<void> = Promise.resolve();
    let firstChunkLogged = false;

    // Fallback only: if the model hasn't produced its first spoken chunk
    // within this window (e.g. a slow tool call before any text), say
    // something so the caller isn't met with dead air. With streaming,
    // first-chunk flushing on a clause boundary, and the direct tool-reply
    // shortcut in runTurn(), real turns should beat this comfortably.
    const FILLER_GRACE_MS = 1200;
    const fillerTimer = setTimeout(() => {
      if (!firstChunkLogged && !signal.aborted) {
        onChunk(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
      }
    }, FILLER_GRACE_MS);

    const onChunk = (chunk: string): void => {
      if (signal.aborted) return;
      clearTimeout(fillerTimer);

      // Fire the request now — do not wait for the chain.
      const started = cartesiaStart(this.ttsConfig, chunk, signal).catch((e) => {
        if (e?.name !== 'AbortError') console.error('[cartesia start]', e?.message || e);
        return null;
      });

      chunkChain = chunkChain.then(async () => {
        // Contained: one chunk failing to synthesize must not reject the
        // chain, because every later chunk is appended to it and would then
        // be silently skipped — losing the rest of the turn's audio.
        try {
          const res = await started;
          if (signal.aborted || !res) {
            // Nobody will read this body; release it rather than leak the stream.
            await res?.body?.cancel().catch(() => {});
            return;
          }
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            console.log(`[${tag}] ⏱ first-chunk-spoken: ${Date.now() - t0}ms`);
          }
          await cartesiaDrain(res, this.streamSid, this.twWs!, signal, false);
        } catch (e: any) {
          if (e?.name !== 'AbortError') console.error('[tts chunk]', e?.message || e);
        }
      });
    };

    try {
      await runTurn(this.env, this.session, this.callSid, text, onChunk, this.cache)
        .catch(e => { if (e.name !== 'AbortError') console.error('[turn]', e.message); });

      await chunkChain;
      if (!signal.aborted && this.twWs && this.twWs.readyState === WebSocket.OPEN) {
        this.twWs.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: 'done' } }));
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') console.error('[turn]', e.message);
    } finally {
      clearTimeout(fillerTimer);
      if (this.currentAbort === ac) { this.currentAbort = undefined; this.busy = false; }
    }
  }

  // runTurn() skips its per-turn D1 transcript write when a call cache is in
  // play (every turn would otherwise be a SELECT + UPDATE rewriting the whole
  // growing turns array, on the DO's single thread, alongside the next turn).
  // This is the one write for the call.
  private async flushTranscript(): Promise<void> {
    if (this.transcriptFlushed || !this.session || this.cache.history.length === 0) return;
    this.transcriptFlushed = true;
    try {
      await saveTranscript(this.env, {
        callSid: this.callSid,
        customerIdHashed: this.session.sub,
        businessType: this.session.businessType,
        turns: this.cache.history,
      });
    } catch (e: any) {
      console.error('[transcript flush]', e?.message || e);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(message as string);
    } catch (e: any) {
      console.error('[twilio] invalid message', e?.message || e);
      return;
    }

    if (msg.event === 'start') {
      this.callSid = msg.start.callSid;
      this.streamSid = msg.start.streamSid;
      console.log(`[call] ${this.callSid.slice(-8)}`);

      // The WebSocket itself is unauthenticated; the signed token minted by
      // /twilio/inbound (which *is* Twilio-signature-checked) proves this
      // stream came from a real inbound call. Outside production, a missing
      // token is tolerated so scripts/simulate-call.mjs keeps working.
      const params = msg.start.customParameters ?? {};
      let businessType: string | undefined;
      if (params.streamToken) {
        businessType = (await verifyStreamToken(this.env, params.streamToken)) ?? undefined;
        if (!businessType) { this.reject('invalid stream token'); return; }
      } else if (isProduction(this.env)) {
        this.reject('missing stream token');
        return;
      } else {
        businessType = params.businessType ?? this.urlBusinessType;
      }

      this.startStt();
      this.session = buildDefaultTwilioSession(this.env, businessType) ?? undefined;

      // Kick the sector lookup off, but don't block the greeting on it — it's
      // a KV hit at best and a D1 round trip on a cold cache, and it used to
      // sit directly in front of the caller's very first audio.
      const sectorPromise = businessType
        ? getSector(this.env, businessType).catch(() => null)
        : Promise.resolve(null);
      // Seed the call cache as soon as it lands, so runTurn's first
      // invocation doesn't re-fetch it.
      sectorPromise.then(m => { if (m) this.cache.sectorMeta = m; });

      const capabilityHint = businessType === 'health_nav'
        ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
        : "I can tell you about our services and hours, or book you an appointment — what can I help with?";

      this.busy = true;
      this.speakStartedAt = Date.now();
      // The greeting gets a real AbortController registered as the current
      // turn, so a caller who talks over it actually cuts it off. Without a
      // signal, bargeIn() would clear Twilio's buffer while Cartesia kept
      // streaming fresh frames into it — the greeting would talk on.
      const greetAbort = new AbortController();
      this.currentAbort = greetAbort;
      const greetSignal = greetAbort.signal;
      // Opener first (no dependency on the lookup), then the part that needs
      // the business name. Two Cartesia calls, but they drain in order and
      // the caller hears audio a KV/D1 round trip sooner.
      this.speak('Thanks for calling!', greetSignal, false)
        .then(async () => {
          if (greetSignal.aborted) return;
          const sectorMeta = await sectorPromise;
          if (greetSignal.aborted) return;
          const storeName = sectorMeta?.name ?? businessType ?? 'us';
          await this.speak(
            `You've reached ${storeName}. I'm Mogi, your voice assistant. ${capabilityHint}`,
            greetSignal,
          );
        })
        .catch(e => { if (e?.name !== 'AbortError') console.error('[greeting]', e?.message || e); })
        .finally(() => {
          // Only release if a real turn hasn't already taken over.
          if (this.currentAbort === greetAbort) { this.currentAbort = undefined; this.busy = false; }
        });

      // Prefetch the booked-slot set in parallel with the greeting/caller's
      // first utterance, so the first check_availability call in the call
      // (frequently the very first tool call) doesn't pay a D1 round trip.
      // Not applicable to health_nav (no service-booking model).
      if (businessType && businessType !== 'health_nav') {
        getBookedDatetimes(this.env, businessType)
          .then(s => { this.cache.bookedDatetimes = s; })
          .catch(e => console.error('[bookedDatetimes prefetch]', e?.message || e));
      }

    } else if (msg.event === 'media') {
      // Always forward — even while busy — so STT can detect barge-in
      const bytes = base64ToBytes(msg.media.payload);
      this.stt.sendAudio(bytes.buffer as ArrayBuffer);

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
    if (this.currentAbort) this.currentAbort.abort();
    this.stt.close();
    this.ctx.waitUntil(this.flushTranscript());
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
    console.error('[twilio ws]', (error as any)?.message || error);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
