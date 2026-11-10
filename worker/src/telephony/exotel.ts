import { mulawToPcm16le, pcm16leToMulaw } from './g711';
import {
  base64ToBytes, bytesToBase64, parseJsonFrame, str, stringRecord,
  type InboundEvent, type TelephonyAdapter,
} from './types';

// Exotel AgentStream — the Voicebot applet's bidirectional WebSocket.
//
//   Exotel → us: connected, start, media, dtmf, mark, stop
//   us → Exotel: media, mark, clear
//
// Audio is base64 16-bit little-endian linear PCM ("raw/slin"), mono, 8 kHz
// unless the stream URL asks for ?sample-rate=16000|24000 (ours never does).
// Ids are snake_case (stream_sid, call_sid); the start event carries the
// caller (`from`) and the called ExoPhone (`to`).
//
// Outbound media must be a multiple of 320 bytes (20 ms at 8 kHz) and Exotel
// recommends at least 3200 bytes (200 ms) per frame to ride out jitter, so
// audio is buffered into ≥3200-byte frames and the tail is padded with
// silence to a 320-byte boundary when a mark (end of a spoken chunk) flushes it.
//
// Formats from Exotel's own reference bots (github.com/exotel/Agent-Stream,
// Agent-Stream-echobot) and Pipecat's ExotelFrameSerializer; verify against a
// live call's start event (media_format) before relying on anything beyond it.

export const EXOTEL_SAMPLE_RATE = 8000;
export const EXOTEL_FRAME_ALIGN = 320;        // bytes — 20 ms of 8 kHz 16-bit PCM
export const EXOTEL_MIN_FRAME = 3200;         // bytes — 200 ms
export const EXOTEL_MAX_FRAME = 96000;        // bytes — under Exotel's 100 000 cap, 320-aligned

export class ExotelAdapter implements TelephonyAdapter {
  readonly provider = 'exotel' as const;
  private streamSid = '';
  private pending: Uint8Array = new Uint8Array(0);

  parse(data: string | ArrayBuffer): InboundEvent | null {
    const msg = parseJsonFrame(data);
    if (!msg) return null;
    switch (msg.event) {
      case 'media': {
        const payload = str(msg.media?.payload);
        return payload ? { type: 'media', audio: pcm16leToMulaw(base64ToBytes(payload)) } : null;
      }
      case 'mark': {
        const name = str(msg.mark?.name);
        return name ? { type: 'mark', name } : null;
      }
      case 'start': {
        const s = msg.start ?? {};
        this.streamSid = str(s.stream_sid) ?? str(msg.stream_sid) ?? str(s.streamSid) ?? str(msg.streamSid) ?? '';
        const rate = Number(String(s.media_format?.sample_rate ?? EXOTEL_SAMPLE_RATE).replace(/\D/g, ''));
        if (rate && rate !== EXOTEL_SAMPLE_RATE) {
          console.warn(`[exotel] stream is ${rate} Hz; only ${EXOTEL_SAMPLE_RATE} Hz is supported — remove ?sample-rate from the stream URL`);
        }
        return {
          type: 'start',
          start: {
            callSid: str(s.call_sid) ?? str(s.callSid) ?? '',
            streamSid: this.streamSid,
            params: customParams(s.custom_parameters),
            from: str(s.from),
            to: str(s.to),
          },
        };
      }
      case 'stop':
        return { type: 'stop' };
      default:
        return null;   // connected, dtmf, anything new
    }
  }

  audio(mulaw: Uint8Array): string[] {
    if (!mulaw.length) return [];
    this.pending = concat(this.pending, mulawToPcm16le(mulaw));
    const out: string[] = [];
    while (this.pending.length >= EXOTEL_MIN_FRAME) {
      const n = Math.min(EXOTEL_MAX_FRAME, this.pending.length - (this.pending.length % EXOTEL_FRAME_ALIGN));
      out.push(this.media(this.pending.subarray(0, n)));
      this.pending = this.pending.slice(n);
    }
    return out;
  }

  mark(name: string): string[] {
    const out: string[] = [];
    if (this.pending.length) {
      const padded = new Uint8Array(Math.ceil(this.pending.length / EXOTEL_FRAME_ALIGN) * EXOTEL_FRAME_ALIGN);
      padded.set(this.pending);   // zero-filled tail = PCM silence
      out.push(this.media(padded));
      this.pending = new Uint8Array(0);
    }
    out.push(JSON.stringify({ event: 'mark', stream_sid: this.streamSid, mark: { name } }));
    return out;
  }

  clear(): string[] {
    this.pending = new Uint8Array(0);
    return [JSON.stringify({ event: 'clear', stream_sid: this.streamSid })];
  }

  private media(pcm: Uint8Array): string {
    return JSON.stringify({ event: 'media', stream_sid: this.streamSid, media: { payload: bytesToBase64(pcm) } });
  }
}

// Exotel sends custom_parameters as an object; some paths send the raw
// query string ("a=1&b=2") instead.
function customParams(v: unknown): Record<string, string> {
  if (typeof v === 'string') return Object.fromEntries(new URLSearchParams(v.replace(/^\?/, '')));
  return stringRecord(v);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
