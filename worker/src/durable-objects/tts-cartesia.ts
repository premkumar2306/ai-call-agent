// Cartesia streaming TTS — ported from relay/relay.js's cartesiaSpeak.
// Uses res.body.getReader() rather than `for await...of res.body` for portability
// across Workers runtime versions.
//
// Synthesis is split into two halves so the caller can overlap them:
//
//   cartesiaStart() — issues the HTTP request and resolves once headers are
//     back. This is where TTFB is paid (~150-300ms).
//   cartesiaDrain() — streams the body out to the caller (via the telephony
//     adapter) in real time.
//
// Audio downloads faster than it plays, so draining chunk N occupies far less
// wall-clock than Twilio spends playing it. Keeping the two separable lets
// CallRelay fire chunk N+1's request while chunk N is still being spoken,
// instead of serializing TTFB behind the previous chunk's full download.
//
// A persistent Cartesia WebSocket (wss://api.cartesia.ai/tts/websocket) would
// remove per-chunk TTFB entirely and allow streaming partial text in, but that
// is a protocol rewrite that cannot be validated without live credentials —
// deliberately out of scope here. See the PR description.

export const CARTESIA_VERSION = '2026-03-01';
export const DEFAULT_CARTESIA_MODEL = 'sonic-3.5';
export const DEFAULT_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'; // Skylar - Friendly Guide

export interface CartesiaConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
}

/** Issues the synthesis request. Resolves when response headers are available. */
export async function cartesiaStart(
  cfg: CartesiaConfig,
  text: string,
  signal?: AbortSignal,
): Promise<Response | null> {
  if (signal?.aborted) return null;

  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', signal,
    headers: {
      'Cartesia-Version': CARTESIA_VERSION,
      'X-API-Key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: cfg.modelId ?? DEFAULT_CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: cfg.voiceId ?? DEFAULT_VOICE_ID },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    console.error('[cartesia]', res.status, body.slice(0, 500));
    return null;
  }
  return res;
}

/**
 * Streams an already-started synthesis response (μ-law 8 kHz) to `sendAudio`
 * — CallRelay's telephony adapter, which frames it for the carrier. Stops
 * early on abort, or when `sendAudio` returns false (the call's socket closed).
 */
export async function cartesiaDrain(
  res: Response | null,
  sendAudio: (mulaw: Uint8Array) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!res || !res.body) return;

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted || !sendAudio(value)) break;
    }
  } finally {
    reader.releaseLock();
  }
}
