import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionPayload } from '../types';
import { buildDefaultTwilioSession } from '../middleware';
import { runTurn } from '../services/turn.service';
import { getSector } from '../services/sector.service';
import { getBookedDatetimes } from '../services/tool-router.service';
import { createCallCache, type CallCache } from '../services/call-context';
import { createDeepgramSTT, type Stt } from './stt-deepgram';
import { cartesiaSpeak } from './tts-cartesia';

// One CallRelay instance per phone call. Ported from relay/relay.js's per-connection
// WebSocket handler (Twilio Media Streams → Deepgram STT → runTurn() → Cartesia TTS),
// with barge-in (interrupt TTS when the caller starts talking again) preserved.
//
// ElevenLabs STT and macOS `say` TTS from relay.js are intentionally not ported —
// neither is Workers-compatible (Node SDK / child_process). relay.js stays as a
// local-dev-only fallback for those.

const FILLERS = ['One moment...', 'Let me check that for you...', 'Almost there...'];

export class CallRelay extends DurableObject<Env> {
  private twWs?: WebSocket;
  private stt: Stt = { sendAudio: () => {}, close: () => {} };
  private session?: SessionPayload;
  private urlBusinessType?: string;
  private callSid = 'relay';
  private streamSid = '';
  private busy = false;
  private currentAbort?: AbortController;
  // Call-lifetime cache: sector metadata, product list, tool defs, history,
  // orders and booked-slot set all live here instead of round-tripping to
  // KV/D1 on every turn. See issue #7 / worker/src/services/call-context.ts.
  private cache: CallCache = createCallCache();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Query-string businessType is a fallback for our own synthetic test harness
    // (relay/test/simulate-call.js), which connects with the full URL directly.
    // Twilio's real Media Streams client does not reliably forward the query
    // string from <Stream url="...">, so the 'start' event's customParameters
    // (set via <Parameter> in the TwiML) is the source of truth for real calls.
    this.urlBusinessType = url.searchParams.get('businessType') ?? undefined;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.twWs = server;

    // STT is async (needs an await to open the Deepgram WS); use a no-op until ready
    createDeepgramSTT(
      this.env.DEEPGRAM_API_KEY ?? '',
      (text) => { this.handleTranscript(text); },
      /^(1|true)$/i.test(this.env.DG_DEBUG ?? ''),
    )
      .then(s => { this.stt = s; })
      .catch((e) => {
        console.error('[stt startup]', e?.message || e);
        if (this.twWs?.readyState === WebSocket.OPEN) this.twWs.close(1011, 'STT startup failed');
      });

    return new Response(null, { status: 101, webSocket: client });
  }

  private bargeIn() {
    if (this.currentAbort) { this.currentAbort.abort(); this.currentAbort = undefined; }
    if (this.twWs && this.twWs.readyState === WebSocket.OPEN) {
      this.twWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
    this.busy = false;
  }

  private async speak(text: string, signal?: AbortSignal, sendMark: boolean = true): Promise<void> {
    console.log(`[tts] "${text}"`);
    const t0 = Date.now();
    await cartesiaSpeak(
      { apiKey: this.env.CARTESIA_API_KEY!, voiceId: this.env.CARTESIA_VOICE_ID, modelId: this.env.CARTESIA_MODEL_ID },
      text, this.streamSid, this.twWs!, signal, sendMark,
    );
    console.log(`[tts] ⏱ "${text.slice(0, 20)}": ${Date.now() - t0}ms`);
  }

  private async handleTranscript(text: string) {
    if (!this.session || !this.twWs) return;

    if (this.busy) {
      console.log(`[barge-in] "${text.slice(0, 40)}"`);
      this.bargeIn();
    }

    this.busy = true;
    const ac = new AbortController();
    this.currentAbort = ac;
    const { signal } = ac;
    const tag = this.callSid.slice(-8);
    const t0 = Date.now();

    // Chunks stream in from runTurn() as sentences become ready; chain them
    // so TTS calls run strictly one-after-another (no overlapping audio) and
    // so barge-in (via `signal`) stops the sequence cleanly instead of
    // continuing to speak already-queued chunks.
    let chunkChain: Promise<void> = Promise.resolve();
    let firstChunkLogged = false;

    // Fallback only: if the model hasn't produced its first spoken chunk
    // within this window (e.g. a slow tool call before any text), say
    // something so the caller isn't met with dead air. With streaming,
    // real turns should usually beat this comfortably, so it should rarely
    // fire — kept as a safety net rather than the primary latency fix it
    // used to be.
    const FILLER_GRACE_MS = 1500;
    const fillerTimer = setTimeout(() => {
      if (!firstChunkLogged && !signal.aborted) {
        onChunk(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
      }
    }, FILLER_GRACE_MS);

    const onChunk = (chunk: string): Promise<void> => {
      chunkChain = chunkChain.then(async () => {
        if (signal.aborted) return;
        clearTimeout(fillerTimer);
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          console.log(`[${tag}] ⏱ first-chunk-spoken: ${Date.now() - t0}ms`);
        }
        await this.speak(chunk, signal, false);
      });
      return chunkChain;
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

      const businessType = msg.start.customParameters?.businessType ?? this.urlBusinessType;
      this.session = buildDefaultTwilioSession(this.env, businessType) ?? undefined;

      const sectorMeta = businessType ? await getSector(this.env, businessType).catch(() => null) : null;
      // Seed the call cache with what greeting already fetched, so runTurn's
      // very first invocation doesn't re-fetch it (it was previously calling
      // getSector() again itself on turn 1 despite this same lookup having
      // just happened here).
      this.cache.sectorMeta = sectorMeta;
      const storeName = sectorMeta?.name ?? businessType ?? 'us';
      const capabilityHint = businessType === 'health_nav'
        ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
        : "I can tell you about our services and hours, or book you an appointment — what can I help with?";
      const greeting = `Welcome to ${storeName}. I'm Mogi, your voice assistant. ${capabilityHint}`;

      this.busy = true;
      this.speak(greeting)
        .catch(e => console.error('[greeting]', e?.message || e))
        .finally(() => { this.busy = false; });

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
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    if (this.currentAbort) this.currentAbort.abort();
    this.stt.close();
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
