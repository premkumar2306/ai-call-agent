// Telephony audio helpers. Twilio Media Streams carry 8 kHz mono G.711 µ-law
// both ways; Deepgram and Cartesia speak it natively, other providers don't.
// Sarvam STT wants 16-bit PCM (16 kHz preferred), and its TTS stream may come
// back with a WAV header or as 16-bit PCM — these helpers bridge the formats.

// ── G.711 µ-law ─────────────────────────────────────────────────────────────

const BIAS = 0x84;
const CLIP = 32635;

/** µ-law byte → 16-bit linear sample (ITU-T G.711). */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return (sign ? -magnitude : magnitude) | 0;   // | 0: no -0
}

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE[i] = mulawToLinear(i);

/** 16-bit linear sample → µ-law byte (ITU-T G.711). */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE[bytes[i]];
  return out;
}

export function encodeMulaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
  return out;
}

/**
 * 8 kHz µ-law → 16 kHz 16-bit PCM, by linear interpolation. Stateful so the
 * interpolation is continuous across Twilio's 20 ms frames: each output pair
 * is (midpoint from the previous sample, this sample).
 */
export class MulawUpsampler {
  private prev = 0;

  push(bytes: Uint8Array): Int16Array {
    const out = new Int16Array(bytes.length * 2);
    let prev = this.prev;
    for (let i = 0; i < bytes.length; i++) {
      const s = DECODE[bytes[i]];
      out[2 * i] = (prev + s) >> 1;
      out[2 * i + 1] = s;
      prev = s;
    }
    this.prev = prev;
    return out;
  }
}

/** Little-endian bytes of 16-bit PCM samples (pcm_s16le). */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(2 * i, samples[i], true);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: String.fromCharCode(...bigArray) overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ── TTS output → 8 kHz µ-law ────────────────────────────────────────────────

export type TtsCodec = 'mulaw' | 'linear16';

/**
 * Normalises a streamed TTS body to raw 8 kHz µ-law for Twilio. A leading
 * WAV header is parsed and dropped, and its format (µ-law or 16-bit PCM)
 * wins over `assumed`; 16-bit PCM is encoded to µ-law, carrying an odd
 * trailing byte over to the next chunk. Audio that isn't 8 kHz is logged,
 * not resampled — the request asks for 8000 Hz.
 */
export function toMulaw8k(body: ReadableStream<Uint8Array>, assumed: TtsCodec, tag = 'tts'): ReadableStream<Uint8Array> {
  let codec: TtsCodec = assumed;
  let head: Uint8Array | null = new Uint8Array(0);   // bytes before the format is known
  let carry: Uint8Array = new Uint8Array(0);           // odd byte of a split PCM sample

  const emit = (bytes: Uint8Array, out: TransformStreamDefaultController<Uint8Array>) => {
    if (!bytes.length) return;
    if (codec === 'mulaw') { out.enqueue(bytes); return; }
    let buf = bytes;
    if (carry.length) { buf = concat(carry, bytes); carry = new Uint8Array(0); }
    const even = buf.length & ~1;
    if (even < buf.length) carry = buf.slice(even);
    if (!even) return;
    const view = new DataView(buf.buffer, buf.byteOffset, even);
    const samples = new Int16Array(even / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(2 * i, true);
    out.enqueue(encodeMulaw(samples));
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      if (head === null) { emit(chunk, out); return; }
      head = concat(head, chunk);
      if (head.length < 4) return;
      if (!isRiff(head)) { const h = head; head = null; emit(h, out); return; }
      const parsed = parseWavHeader(head);
      if (parsed === 'need-more') {
        if (head.length > 4096) {
          // No data chunk in sight: assume the canonical 44-byte header.
          console.error(`[${tag}] unparseable WAV header — skipping 44 bytes`);
          const h = head; head = null; emit(h.subarray(44), out);
        }
        return;
      }
      if (parsed.format) {
        codec = parsed.format;
        if (parsed.sampleRate !== 8000) console.error(`[${tag}] TTS audio is ${parsed.sampleRate} Hz, expected 8000`);
      }
      const rest = head.subarray(parsed.dataOffset);
      head = null;
      emit(rest, out);
    },
    flush(out) {
      // A body shorter than a WAV header's magic: just audio.
      if (head && head.length && !isRiff(head)) emit(head, out);
    },
  }));
}

function isRiff(b: Uint8Array): boolean {
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46; // "RIFF"
}

/**
 * Finds the start of the `data` chunk in a WAV header and the format from
 * its `fmt ` chunk (1 = PCM, 7 = µ-law).
 */
export function parseWavHeader(b: Uint8Array): 'need-more' | { dataOffset: number; format?: TtsCodec; sampleRate?: number } {
  if (b.length < 12) return 'need-more';
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let format: TtsCodec | undefined;
  let sampleRate: number | undefined;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const size = view.getUint32(off + 4, true);
    if (id === 'data') return { dataOffset: off + 8, format, sampleRate };
    if (id === 'fmt ') {
      if (off + 8 + 16 > b.length) return 'need-more';
      const audioFormat = view.getUint16(off + 8, true);
      sampleRate = view.getUint32(off + 12, true);
      const bits = view.getUint16(off + 22, true);
      format = audioFormat === 7 ? 'mulaw' : audioFormat === 1 && bits === 16 ? 'linear16' : undefined;
    }
    off += 8 + size + (size & 1);
  }
  return 'need-more';
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
