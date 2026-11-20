import { describe, expect, it, vi } from 'vitest';
import { AudioCache, audioCacheKey } from '../src/services/audio-cache';
import { fillerGroup, pickFiller, voiceLines } from '../src/services/voice-language';
import { INDIA_DENTAL } from '../src/services/presets';

// A KV namespace in memory (only get/put are used).
function fakeKv() {
  const m = new Map<string, ArrayBuffer>();
  return {
    m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: Uint8Array) => { m.set(k, v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer); }),
  } as unknown as KVNamespace & { m: Map<string, ArrayBuffer> };
}
const clip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const tts = (calls: { n: number }) => ({ name: 'cartesia', start: async () => { calls.n++; return new Response(clip); } });

describe('audio cache', () => {
  it('keys differ by provider, voice, language and text', async () => {
    const base = { provider: 'cartesia', voice: 'v1|sonic', language: 'en', text: 'One moment.' };
    const keys = await Promise.all([base, { ...base, provider: 'sarvam' }, { ...base, voice: 'v2|sonic' }, { ...base, language: 'hi' }, { ...base, text: 'One second.' }].map(audioCacheKey));
    expect(new Set(keys).size).toBe(5);
    expect(await audioCacheKey(base)).toBe(keys[0]);
  });

  it('synthesizes on a miss, stores the clip, and replays it without synthesizing again', async () => {
    const kv = fakeKv(), pending: Promise<unknown>[] = [], calls = { n: 0 };
    const cache = new AudioCache(kv, p => pending.push(p));
    const first = await cache.start(tts(calls), 'v', 'en', 'One moment.');
    expect(first.hit).toBe(false);
    expect(new Uint8Array(await first.res!.arrayBuffer())).toEqual(clip);
    await Promise.all(pending);
    expect(kv.m.size).toBe(1);

    // A different call (new AudioCache) replays it from KV.
    const second = await new AudioCache(kv, () => {}).start(tts(calls), 'v', 'en', 'One moment.');
    expect(second.hit).toBe(true);
    expect(new Uint8Array(await second.res!.arrayBuffer())).toEqual(clip);
    expect(calls.n).toBe(1);
  });

  it('a failed synthesis is a miss and stores nothing', async () => {
    const kv = fakeKv(), pending: Promise<unknown>[] = [];
    const r = await new AudioCache(kv, p => pending.push(p)).start({ name: 'cartesia', start: async () => null }, 'v', 'en', 'x');
    expect(r).toEqual({ res: null, hit: false });
    expect(kv.m.size).toBe(0);
  });
});

describe('filler lines', () => {
  it('groups tools by what they do', () => {
    expect(fillerGroup('check_availability')).toBe('availability');
    expect(fillerGroup('book_appointment')).toBe('booking');
    expect(fillerGroup('reschedule_booking')).toBe('change');
    expect(fillerGroup('get_booking_status')).toBe('lookup');
    expect(fillerGroup('transfer_to_staff')).toBe('other');
  });

  it('never repeats the filler just said', () => {
    const pool = voiceLines('en').fillersBy.availability;
    let last = '';
    for (let n = 0; n < 12; n++) {
      const f = pickFiller(pool, n, last);
      expect(f).not.toBe(last);
      last = f;
    }
    expect(pickFiller(['only'], 0, 'only')).toBe('only');
  });

  it('every language has a filler for every group, and none claims an outcome', () => {
    for (const lang of ['en', 'hi', 'hi-en', 'kn', 'te', 'ta'] as const) {
      for (const pool of Object.values(voiceLines(lang).fillersBy)) {
        expect(pool.length).toBeGreaterThan(0);
        for (const line of pool) expect(line).not.toMatch(/\b(confirmed|done|connected|all set)\b/i);
      }
    }
  });

  it('is on in the India dental preset', () => {
    expect(INDIA_DENTAL.naturalFillers).toBe(true);
  });
});
