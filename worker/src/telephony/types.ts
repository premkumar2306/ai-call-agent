// Telephony adapter layer: the one place that knows a carrier's media-stream
// WebSocket protocol. CallRelay only ever sees the normalised events below
// and hands back μ-law 8 kHz audio, marks and clears; each adapter turns
// those into its carrier's wire messages.
//
// Adapters are pure (string in → event out, call in → strings out), one
// instance per call, so they are unit-testable without a socket.

export type TelephonyProvider = 'twilio' | 'exotel' | 'plivo';

export const TELEPHONY_PROVIDERS: readonly TelephonyProvider[] = ['twilio', 'exotel', 'plivo'];

export function isTelephonyProvider(v: unknown): v is TelephonyProvider {
  return typeof v === 'string' && (TELEPHONY_PROVIDERS as readonly string[]).includes(v);
}

export interface CallStart {
  /** The carrier's id for the whole call (Twilio CallSid, Exotel call_sid, Plivo callId). */
  callSid: string;
  /** The carrier's id for this media stream; echoed on every outbound message. */
  streamSid: string;
  /** Custom parameters the carrier forwarded (Twilio <Parameter>, Exotel custom_parameters). */
  params: Record<string, string>;
  /** Caller and called numbers, when the carrier puts them in the start event (Exotel does). */
  from?: string;
  to?: string;
}

export type InboundEvent =
  | { type: 'start'; start: CallStart }
  /** Caller audio, already converted to μ-law 8 kHz. */
  | { type: 'media'; audio: Uint8Array }
  /** Playback reached a mark we sent earlier. */
  | { type: 'mark'; name: string }
  | { type: 'stop' };

export interface TelephonyAdapter {
  readonly provider: TelephonyProvider;
  /** Parses one inbound frame. null for frames the relay doesn't act on (connected, dtmf, junk). */
  parse(data: string | ArrayBuffer): InboundEvent | null;
  /** Outbound frames that play this μ-law 8 kHz audio (may be buffered until the next mark). */
  audio(mulaw: Uint8Array): string[];
  /** Frames that flush any buffered audio and then place a named mark. */
  mark(name: string): string[];
  /** Frames that drop audio queued on the carrier side (barge-in). */
  clear(): string[];
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Parses a JSON text frame; binary frames and invalid JSON give null. */
export function parseJsonFrame(data: string | ArrayBuffer): any {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

export function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v)) {
    const s = str(val);
    if (s !== undefined) out[k] = s;
  }
  return out;
}
