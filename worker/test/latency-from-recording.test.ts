import { describe, expect, it } from 'vitest';
// @ts-ignore — plain ESM script helpers (typed by the .d.mts next to them)
import { encodeWav, findBursts, findDtmf, perTurn, readWav, turnsOf } from '../scripts/latency-from-recording-lib.mjs';

const SR = 8000;

// A 16 s synthetic handset recording: noise floor, a DTMF "5" at 1.0–1.3 s, the caller's lines and the
// agent's replies as voiced-ish tone mixes.
function recording() {
  const x = new Float32Array(SR * 16);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.004;
  const tone = (from: number, to: number, freqs: number[], amp: number) => {
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
      let v = 0;
      for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SR);
      x[i] += (amp * v) / freqs.length;
    }
  };
  tone(1.0, 1.3, [770, 1336], 0.4);          // DTMF 5
  tone(3.0, 4.5, [180, 410, 900], 0.35);     // caller line 1 (ends 4.5)
  tone(5.2, 7.0, [150, 300, 700], 0.3);      // reply 1 starts 5.2 → heard 700 ms
  tone(9.0, 10.0, [200, 480, 1100], 0.35);   // caller line 2 (ends 10.0)
  tone(11.1, 12.5, [150, 330, 760], 0.3);    // reply 2 starts 11.1 → heard 1100 ms
  return encodeWav(x, SR);
}

describe('latency-from-recording', () => {
  const { sampleRate, samples } = readWav(recording());

  it('round-trips a WAV', () => {
    expect(sampleRate).toBe(SR);
    expect(samples.length).toBe(SR * 16);
  });

  it('finds the DTMF digit and its start', () => {
    const d = findDtmf(samples, sampleRate)!;
    expect(d.digit).toBe('5');
    expect(d.start).toBeGreaterThan(0.95);
    expect(d.start).toBeLessThan(1.06);
  });

  it('does not mistake speech for DTMF', () => {
    expect(findDtmf(samples.subarray(Math.round(3.0 * SR), Math.round(4.5 * SR)), SR)).toBeNull();
  });

  it('finds caller and reply bursts, ignoring the DTMF tone', () => {
    const d = findDtmf(samples, sampleRate)!;
    const b = findBursts(samples, sampleRate, { mask: [[d.start - 0.05, d.end + 0.1]] });
    expect(b.length).toBe(4);
    expect(b[0].start).toBeCloseTo(3.0, 1);
    expect(b[0].end).toBeCloseTo(4.5, 1);
    expect(b[1].start).toBeCloseTo(5.2, 1);
  });

  it('heard latency per turn, next to the server number', () => {
    const d = findDtmf(samples, sampleRate)!;
    const bursts = findBursts(samples, sampleRate, { mask: [[d.start - 0.05, d.end + 0.1]] });
    // Server clock: the DTMF reached the server at 5_000_000 ms. Its end-of-speech signals came 350 ms
    // after the caller stopped; the first audio frame left 300 ms later (turn 1) and 200 ms later (turn 2).
    const sync = 5_000_000;
    const at = (recSec: number) => sync + Math.round((recSec - 1.0) * 1000);
    const api = { success: true, data: { sync_dtmf_at: sync, turns: [
      { turn_n: 1, provider: 'plivo', started_at: at(4.85), t_speech_end: 0, t_first_sent: 300, endpointing_ms: 250 },
      { turn_n: 2, provider: 'plivo', started_at: at(10.35), t_speech_end: 0, t_first_sent: 200, endpointing_ms: 250 },
    ] } };
    const { turns, syncDtmfAt } = turnsOf(api);
    const rows = perTurn(bursts, turns, { dtmfAt: d.start, syncDtmfAt: syncDtmfAt! });
    expect(rows[0].heardMs).toBeGreaterThan(660);
    expect(rows[0].heardMs).toBeLessThan(740);
    expect(rows[0].diffMs).toBeGreaterThan(360);   // 700 heard − 300 server
    expect(rows[0].diffMs).toBeLessThan(440);
    expect(rows[1].heardMs).toBeGreaterThan(1060);
    expect(rows[1].heardMs).toBeLessThan(1140);
    expect(rows[1].serverMs).toBe(200);
  });

  it('reports a turn it cannot find instead of guessing', () => {
    const rows = perTurn([{ start: 3, end: 4 }], [{ turn_n: 1, started_at: 5_000_000 + 60_000, t_speech_end: 0, t_first_sent: 100 }], { dtmfAt: 1, syncDtmfAt: 5_000_000 });
    expect(rows[0].heardMs).toBeNull();
    expect(rows[0].note).toMatch(/no caller speech/);
  });
});
