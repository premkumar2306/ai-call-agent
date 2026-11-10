import {
  base64ToBytes, bytesToBase64, parseJsonFrame, str, stringRecord,
  type InboundEvent, type TelephonyAdapter,
} from './types';

// Twilio Media Streams (bidirectional, <Connect><Stream>):
// https://www.twilio.com/docs/voice/media-streams/websocket-messages
// μ-law 8 kHz both ways, camelCase streamSid. The wire format here is exactly
// what CallRelay sent before the adapter layer existed.
export class TwilioAdapter implements TelephonyAdapter {
  readonly provider = 'twilio' as const;
  private streamSid = '';

  parse(data: string | ArrayBuffer): InboundEvent | null {
    const msg = parseJsonFrame(data);
    if (!msg) return null;
    switch (msg.event) {
      case 'media': {
        const payload = str(msg.media?.payload);
        return payload ? { type: 'media', audio: base64ToBytes(payload) } : null;
      }
      case 'mark': {
        const name = str(msg.mark?.name);
        return name ? { type: 'mark', name } : null;
      }
      case 'start': {
        const s = msg.start ?? {};
        this.streamSid = str(s.streamSid) ?? str(msg.streamSid) ?? '';
        return {
          type: 'start',
          start: {
            callSid: str(s.callSid) ?? '',
            streamSid: this.streamSid,
            params: stringRecord(s.customParameters),
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
    return [JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: bytesToBase64(mulaw) } })];
  }

  mark(name: string): string[] {
    return [JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name } })];
  }

  clear(): string[] {
    return [JSON.stringify({ event: 'clear', streamSid: this.streamSid })];
  }
}
