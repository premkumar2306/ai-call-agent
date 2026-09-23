import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionPayload } from '../types';
import { buildDefaultTwilioSession } from '../middleware';
import { runTurn } from '../services/turn.service';
import { getSector } from '../services/sector.service';
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
    createDeepgramSTT(this.env.DEEPGRAM_API_KEY ?? '', (text) => { this.handleTranscript(text); })
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

  private async speak(text: string, signal?: AbortSignal): Promise<void> {
    console.log(`[tts] "${text}"`);
    const t0 = Date.now();
    await cartesiaSpeak(
      { apiKey: this.env.CARTESIA_API_KEY!, voiceId: this.env.CARTESIA_VOICE_ID, modelId: this.env.CARTESIA_MODEL_ID },
      text, this.streamSid, this.twWs!, signal,
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

    try {
      const replyPromise = runTurn(this.env, this.session, this.callSid, text)
        .then(r => r.spokenResponse)
        .catch(e => { if (e.name !== 'AbortError') console.error('[turn]', e.message); return null; });

      // Most turns finish in ~1s, but real calls can run longer (network/STT
      // jitter, tool calls). Give the turn a long head start before considering
      // a filler at all, and play at most one — fillers should be rare, only
      // for genuinely slow turns, not a routine part of every exchange.
      const FILLER_GRACE_MS = 2500;
      let timer: ReturnType<typeof setTimeout>;
      const turnFinishedFirst = await Promise.race([
        replyPromise.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), FILLER_GRACE_MS); }),
      ]);
      clearTimeout(timer!);

      if (!turnFinishedFirst && !signal.aborted) {
        await this.speak(FILLERS[Math.floor(Math.random() * FILLERS.length)], signal);
      }

      const reply = await replyPromise;
      if (reply && !signal.aborted) await this.speak(reply, signal);

    } catch (e: any) {
      if (e.name !== 'AbortError') console.error('[turn]', e.message);
    } finally {
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
      const storeName = sectorMeta?.name ?? businessType ?? 'us';
      const capabilityHint = businessType === 'health_nav'
        ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
        : "I can tell you about our services and hours, or book you an appointment — what can I help with?";
      const greeting = `Welcome to ${storeName}. I'm Mogi, your voice assistant. ${capabilityHint}`;

      this.busy = true;
      this.speak(greeting)
        .catch(e => console.error('[greeting]', e?.message || e))
        .finally(() => { this.busy = false; });

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
