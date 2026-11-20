// Pre-synthesized μ-law clips for the lines every call repeats: fillers
// ("Let me check the slots for you.") and the greeting. Without it each of
// those is a live voice request (a few hundred ms before the caller hears
// anything, more on Sarvam), and exactly when we're already slow.
//
// A clip is the raw 8 kHz μ-law body the voice provider returned, stored in KV
// under (provider, voice+model, language, text hash). It is filled on first
// use: the first call in a voice synthesizes live and stores the clip while it
// streams; every later call replays it. Only used for businesses with
// "natural fillers" on (sectors.natural_fillers, migration 0032).

import type { TtsProvider } from '../durable-objects/voice-providers';

const PREFIX = 'ac1';
const TTL_S = 30 * 24 * 3600;
// A filler or greeting is a few seconds of audio (8 KB/s); anything bigger isn't one.
const MAX_CLIP_BYTES = 400_000;

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * KV key for one clip. `voice` is everything about the voice that changes the
 * sound (voice id, model, codec) and is hashed, so changing the model never
 * replays old audio.
 */
export async function audioCacheKey(p: { provider: string; voice: string; language: string; text: string }): Promise<string> {
  return `${PREFIX}:${p.provider}:${(await sha(p.voice)).slice(0, 8)}:${p.language}:${await sha(p.text)}`;
}

export interface CachedTts {
  /** The clip as a Response the carrier drain can read (null: synthesis failed). */
  res: Response | null;
  /** true: replayed from the cache; false: synthesized live (and stored). */
  hit: boolean;
}

export class AudioCache {
  // A call's own copy, so a repeated filler doesn't go back to KV.
  private mem = new Map<string, Uint8Array>();

  constructor(private kv: KVNamespace, private wait: (p: Promise<unknown>) => void) {}

  /** Replays the clip for `text` from the cache, or synthesizes it with `tts` and stores it. */
  async start(tts: TtsProvider, voice: string, language: string, text: string, signal?: AbortSignal): Promise<CachedTts> {
    const key = await audioCacheKey({ provider: tts.name, voice, language, text });
    let clip = this.mem.get(key) ?? null;
    if (!clip) {
      try {
        const buf = await this.kv.get(key, 'arrayBuffer');
        if (buf && buf.byteLength) clip = new Uint8Array(buf);
      } catch { /* a KV hiccup is a miss, not a failed filler */ }
      if (clip) this.mem.set(key, clip);
    }
    if (clip) return { res: new Response(clip), hit: true };

    const res = await tts.start(text, signal).catch(() => null);
    if (!res?.body) return { res, hit: false };
    // One branch plays, the other is collected and stored once it completes.
    const [play, keep] = res.body.tee();
    this.wait(this.collect(keep, key));
    return { res: new Response(play), hit: false };
  }

  private async collect(body: ReadableStream<Uint8Array>, key: string): Promise<void> {
    try {
      const parts: Uint8Array[] = [];
      let n = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > MAX_CLIP_BYTES) return;
        parts.push(value);
      }
      if (!n) return;
      const clip = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { clip.set(p, o); o += p.byteLength; }
      this.mem.set(key, clip);
      await this.kv.put(key, clip, { expirationTtl: TTL_S });
    } catch { /* barge-in cancelled the stream, or KV is down: nothing stored */ }
  }
}
