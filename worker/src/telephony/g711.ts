// G.711 μ-law ⇄ 16-bit linear PCM (ITU-T G.711), both at 8 kHz.
//
// The call pipeline works in μ-law 8 kHz internally (what Twilio sends and
// what the Deepgram/Cartesia adapters are configured for). Carriers that speak
// linear PCM instead — Exotel's Voicebot stream is 16-bit little-endian PCM —
// are transcoded at the telephony-adapter boundary, so STT/TTS never need to
// know which carrier the call came in on. The PSTN leg is G.711 anyway, so
// this loses nothing the caller could hear.

const BIAS = 0x84;
const CLIP = 32635;

// Decoding is a 256-entry table.
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  DECODE[i] = sign ? -sample : sample;
}

export function mulawDecodeSample(u: number): number {
  return DECODE[u & 0xff];
}

export function mulawEncodeSample(pcm: number): number {
  let sample = Math.max(-32768, Math.min(32767, pcm | 0));
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** μ-law bytes → 16-bit little-endian PCM bytes (twice the length). */
export function mulawToPcm16le(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) view.setInt16(i * 2, DECODE[mulaw[i]], true);
  return out;
}

/** 16-bit little-endian PCM bytes → μ-law bytes. A trailing odd byte is ignored. */
export function pcm16leToMulaw(pcm: Uint8Array): Uint8Array {
  const n = pcm.length >> 1;
  const out = new Uint8Array(n);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = mulawEncodeSample(view.getInt16(i * 2, true));
  return out;
}
