import {
  base64ToBytes, bytesToBase64, parseJsonFrame, str,
  type InboundEvent, type TelephonyAdapter,
} from './types';

// Plivo Audio Streams, bidirectional (<Stream bidirectional="true"
// contentType="audio/x-mulaw;rate=8000">):
// https://www.plivo.com/docs/voice/xml/the-stream-element
//
//   Plivo → us: start, media, dtmf, playedStream (a checkpoint was reached),
//               clearedAudio
//   us → Plivo: playAudio, checkpoint, clearAudio
//
// μ-law 8 kHz both ways, so no transcoding. Ids are camelCase streamId/callId.
// Checkpoints are Plivo's marks.
export class PlivoAdapter implements TelephonyAdapter {
  readonly provider = 'plivo' as const;
  private streamId = '';

  parse(data: string | ArrayBuffer): InboundEvent | null {
    const msg = parseJsonFrame(data);
    if (!msg) return null;
    switch (msg.event) {
      case 'media': {
        const payload = str(msg.media?.payload);
        return payload ? { type: 'media', audio: base64ToBytes(payload) } : null;
      }
      case 'playedStream':
      case 'played': {
        const name = str(msg.name) ?? str(msg.checkpoint?.name);
        return name ? { type: 'mark', name } : null;
      }
      case 'start': {
        const s = msg.start ?? {};
        this.streamId = str(s.streamId) ?? str(msg.streamId) ?? '';
        return {
          type: 'start',
          start: {
            callSid: str(s.callId) ?? '',
            streamSid: this.streamId,
            params: extraHeaders(msg.extra_headers ?? s.extraHeaders),
            from: str(s.from),
            to: str(s.to),
          },
        };
      }
      case 'stop':
        return { type: 'stop' };
      default:
        return null;
    }
  }

  audio(mulaw: Uint8Array): string[] {
    if (!mulaw.length) return [];
    return [JSON.stringify({
      event: 'playAudio',
      media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: bytesToBase64(mulaw) },
    })];
  }

  mark(name: string): string[] {
    return [JSON.stringify({ event: 'checkpoint', streamId: this.streamId, name })];
  }

  clear(): string[] {
    return [JSON.stringify({ event: 'clearAudio', streamId: this.streamId })];
  }
}

// extraHeaders="a=1,b=2" on <Stream>; tolerate an object too.
function extraHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v === 'string') {
    for (const pair of v.split(/[,;]/)) {
      const i = pair.indexOf('=');
      if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  }
  return out;
}
