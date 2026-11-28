import { describe, expect, it } from 'vitest';
import { LineLevel } from '../src/services/line-level';
import { linearToMulaw } from '../src/durable-objects/audio';

// 20 ms of 8 kHz μ-law: a tone of the given peak amplitude, or silence for 0.
function frame(amp: number): Uint8Array {
  const out = new Uint8Array(160);
  for (let i = 0; i < 160; i++) out[i] = linearToMulaw(Math.round(amp * Math.sin(i * 0.5)));
  return out;
}
const feed = (l: LineLevel, amp: number, ms: number) => { for (let t = 0; t < ms; t += 20) l.push(frame(amp)); };

describe('LineLevel', () => {
  it('measures the voiced run and ends it after a >600 ms pause', () => {
    const l = new LineLevel();
    feed(l, 30, 400);                       // line noise: sets the floor
    feed(l, 6000, 800);                     // speech
    expect(l.snapshot().voicedMs).toBeGreaterThanOrEqual(760);
    feed(l, 30, 400);                       // short pause: run continues
    expect(l.snapshot().voicedMs).toBeGreaterThan(0);
    feed(l, 30, 400);                       // long pause: over
    expect(l.snapshot().voicedMs).toBe(0);
  });
  it('steady line noise is never voiced; the floor follows it', () => {
    const l = new LineLevel();
    feed(l, 300, 3000);
    expect(l.snapshot().voicedMs).toBe(0);
    expect(l.snapshot().noiseFloorDb).toBeLessThan(-35);
  });
  it('a short burst is short', () => {
    const l = new LineLevel();
    feed(l, 30, 400);
    feed(l, 8000, 100);
    expect(l.snapshot().voicedMs).toBeLessThanOrEqual(120);
  });
});
