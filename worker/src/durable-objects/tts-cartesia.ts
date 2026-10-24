// Cartesia streaming TTS — ported from relay/relay.js's cartesiaSpeak.
// Uses res.body.getReader() rather than `for await...of res.body` for portability
// across Workers runtime versions.
//
// Synthesis is split into two halves so the caller can overlap them:
//
//   cartesiaStart() — issues the HTTP request and resolves once headers are
//     back. This is where TTFB is paid (~150-300ms).
//   cartesiaDrain() — streams the body out to Twilio in real time.
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

const CARTESIA_VERSION = '2026-03-01';
const DEFAULT_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'; // Skylar - Friendly Guide

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
      model_id: cfg.modelId ?? 'sonic-3.5',
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

/** Streams an already-started synthesis response out to the Twilio socket. */
export async function cartesiaDrain(
  res: Response | null,
  streamSid: string,
  twWs: WebSocket,
  signal?: AbortSignal,
  sendMark: boolean = true,
): Promise<void> {
  if (!res || !res.body) return;

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted || twWs.readyState !== WebSocket.OPEN) break;
      twWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: bytesToBase64(value) } }));
    }
  } finally {
    reader.releaseLock();
  }

  if (sendMark && !signal?.aborted && twWs.readyState === WebSocket.OPEN) {
    twWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
