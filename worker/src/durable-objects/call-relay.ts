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
import { createCallCache, type CallCache } from '../services/call-context';
import { createDeepgramSTT, isBackchannel, type Stt } from './stt-deepgram';
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

// Don't honour a barge-in within this long of the assistant starting to
// speak. Guards against the leading edge of our own audio echoing back on a
// speakerphone and instantly cutting off the reply we just began.
const BARGE_IN_MIN_SPEAK_MS = 300;

// Fallback only: if the model hasn't produced its first spoken chunk within
// this window (a slow tool call before any text), say something so the
// caller isn't met with dead air.
const FILLER_GRACE_MS = 1200;

interface SpokenChunk { text: string; played: boolean; filler: boolean }

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
    if (!this.agentActive) return;
    if (reason === 'vad' && !/^(1|true)$/i.test(this.env.VOICE_BARGE_IN_ON_VAD ?? '')) return;
    if (Date.now() - this.speakStartedAt < BARGE_IN_MIN_SPEAK_MS) return;
    console.log(`[barge-in] speech-start (${reason}) — stopping TTS`);
    this.bargeIn();
  }

  private handleTranscript(text: string) {
    if (!this.session || !this.twWs) return;

    // "Uh huh" / "okay" while the assistant is mid-reply is the caller
    // listening, not taking the turn — unless what they're hearing asked
    // them something, in which case "yeah" is the answer.
    if (this.agentActive && isBackchannel(text)) {
      const asked = this.active?.chunks.some(c => !c.filler && c.text.includes('?'));
      if (!asked || this.pendingMarks.size === 0) {
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
    this.turnChain = this.turnChain
      .then(() => this.runOneTurn(text, gen))
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

  private async runOneTurn(text: string, gen: number): Promise<void> {
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

    // Chunks stream in from runTurn() as they become ready. Synthesis for a
    // chunk is kicked off the instant it arrives, so its TTFB overlaps with
    // whatever is still playing; only the draining to Twilio is chained, so
    // audio stays strictly sequential and barge-in stops it cleanly.
    let chunkChain: Promise<void> = Promise.resolve();
    let firstChunkLogged = false;

    const queue = (textToSay: string, filler: boolean) => {
      if (signal.aborted) return;
      const chunk: SpokenChunk = { text: textToSay, played: false, filler };
      turn.chunks.push(chunk);
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
            console.log(`[${tag}] ⏱ first-chunk-spoken: ${Date.now() - t0}ms`);
          }
          await this.playChunk(turn, chunk, Promise.resolve(res));
        } catch (e: any) {
          if (e?.name !== 'AbortError') console.error('[tts chunk]', e?.message || e);
        }
      });
    };

    let realChunkSeen = false;
    const fillerTimer = setTimeout(() => {
      if (!realChunkSeen && !signal.aborted) queue(FILLERS[Math.floor(Math.random() * FILLERS.length)], true);
    }, FILLER_GRACE_MS);

    try {
      const result = await runTurn(this.env, this.session!, this.callSid, utterance, {
        onChunk: (chunk) => { realChunkSeen = true; clearTimeout(fillerTimer); queue(chunk, false); },
        cache: this.cache,
        signal,
        heardText: () => this.heardText(turn),
      });
      if (!result.committed) {
        // Caller heard nothing of the reply — keep their words for the next turn.
        this.carryOver = joinUtterances(utterance, this.carryOver);
      } else if (!result.interrupted) {
        turn.committed = true;
      }
      await chunkChain;
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error('[turn]', e?.message || e);
    } finally {
      clearTimeout(fillerTimer);
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
      });
    } catch (e: any) {
      console.error('[transcript flush]', e?.message || e);
    }
  }

  private greet(businessType: string | undefined, sectorPromise: Promise<{ name: string } | null>) {
    const capabilityHint = businessType === 'health_nav'
      ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
      : 'I can answer questions about our services and prices, or book you in — what can I do for you?';

    // The greeting is a turn of its own so a caller who talks over it
    // actually cuts it off. It isn't part of the model's history.
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
        const sectorMeta = await sectorPromise;
        if (signal.aborted) return;
        const storeName = sectorMeta?.name ?? businessType ?? 'us';
        await say(`You've reached ${storeName}. I'm Mogi, the virtual assistant. ${capabilityHint}`);
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

    } else if (msg.event === 'mark') {
      // Twilio reached this point in playback.
      const chunk = this.pendingMarks.get(msg.mark?.name);
      if (chunk) {
        chunk.played = true;
        this.pendingMarks.delete(msg.mark.name);
      }

    } else if (msg.event === 'start') {
      this.callSid = msg.start.callSid;
      this.streamSid = msg.start.streamSid;
      console.log(`[call] ${this.callSid.slice(-8)}`);

      // The WebSocket itself is unauthenticated; the signed token minted by
      // /twilio/inbound (which *is* Twilio-signature-checked) proves this
      // stream came from a real inbound call. Outside production, a missing
      // token is tolerated so scripts/simulate-call.mjs keeps working.
      const params = msg.start.customParameters ?? {};
      let businessType: string | undefined;
      let callerHash: string | undefined;
      if (params.streamToken) {
        const claims = await verifyStreamToken(this.env, params.streamToken);
        if (!claims) { this.reject('invalid stream token'); return; }
        businessType = claims.businessType;
        callerHash = claims.callerHash;
      } else if (isProduction(this.env)) {
        this.reject('missing stream token');
        return;
      } else {
        businessType = params.businessType ?? this.urlBusinessType;
      }

      this.startStt();
      this.session = buildDefaultTwilioSession(this.env, businessType) ?? undefined;
      if (this.session && callerHash) this.session.sub = callerHash;
      const session = this.session;

      // Kick the sector lookup off, but don't block the greeting on it.
      const sectorPromise = businessType
        ? getSector(this.env, businessType).catch(() => null)
        : Promise.resolve(null);
      sectorPromise.then(m => { if (m) this.cache.sectorMeta = m; });

      this.greet(businessType, sectorPromise);

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
