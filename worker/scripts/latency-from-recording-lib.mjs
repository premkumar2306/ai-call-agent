// What the caller actually hears: pure helpers for scripts/latency-from-recording.mjs.
//
// Input is a recording of the handset's audio during a call (one mono or stereo track containing
// the scripted caller's voice, the DTMF sync tone and the agent's replies) plus the call's
// GET /admin/calls/:callSid/turns JSON. Detection is deliberately simple: a DTMF tone found with
// Goertzel filters, and speech bursts found by frame energy against a noise floor.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── Audio in ─────────────────────────────────────────────────────────────────

/** WAV (16-bit PCM or 32-bit float, any channel count) → mono Float32Array in -1…1. */
export function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt, data;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), sampleRate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') { data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size)); break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt/data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  if (!((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new Error(`unsupported WAV (format ${format}, ${bits}-bit); use 16-bit PCM`);
  const n = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      sum += format === 3 ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
    out[i] = sum / channels;
  }
  return { sampleRate, samples: out };
}

/** Mono Float32Array → 16-bit PCM WAV buffer (used by the unit test and for making sample files). */
export function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

/** A WAV is read directly; anything else (MP3, M4A, …) goes through ffmpeg, which must be installed. */
export function loadAudio(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) === 'RIFF') return readWav(buf);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 'wav', '-'], { maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`could not decode ${path}: convert it to WAV first, or install ffmpeg (${r.error?.message ?? String(r.stderr).slice(0, 200)})`);
  return readWav(r.stdout);
}

// ── DTMF sync marker ─────────────────────────────────────────────────────────

const LOW = [697, 770, 852, 941];
const HIGH = [1209, 1336, 1477, 1633];
const KEYS = ['123A', '456B', '789C', '*0#D'];

function goertzelAmp(x, from, n, freq, sr) {
  const w = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = x[from + i] + w * s1 - s2; s2 = s1; s1 = s; }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - w * s1 * s2))) / n;   // amplitude of a pure tone at `freq`
}

/**
 * First DTMF digit in the recording, as {digit, start, end} in seconds, or null.
 * A window counts when its two strongest row/column tones carry most of its energy and are of
 * similar level; the tone must last at least `minMs`.
 */
export function findDtmf(x, sr, { minMs = 40 } = {}) {
  const win = Math.round(sr * 0.03), hop = Math.round(sr * 0.01);
  let run = null;
  for (let f = 0; f + win <= x.length; f += hop) {
    let power = 0;
    for (let i = 0; i < win; i++) power += x[f + i] * x[f + i];
    const rms2 = power / win;
    let digit = null;
    if (rms2 > 1e-5) {
      const lo = LOW.map(fr => goertzelAmp(x, f, win, fr, sr)), hi = HIGH.map(fr => goertzelAmp(x, f, win, fr, sr));
      const li = lo.indexOf(Math.max(...lo)), hi_ = hi.indexOf(Math.max(...hi));
      const share = (lo[li] ** 2 + hi[hi_] ** 2) / 2 / rms2;
      const ratio = lo[li] / hi[hi_];
      if (share > 0.7 && ratio > 0.3 && ratio < 3.3) digit = KEYS[li][hi_];
    }
    if (digit && run && run.digit === digit) run.end = (f + win) / sr;
    else if (digit) run = { digit, start: f / sr, end: (f + win) / sr };
    else { if (run && (run.end - run.start) * 1000 >= minMs) return run; run = null; }
  }
  return run && (run.end - run.start) * 1000 >= minMs ? run : null;
}

// ── Speech bursts ────────────────────────────────────────────────────────────

/**
 * Stretches of audible sound as [{start, end}] seconds. A frame is "active" above a threshold of
 * 3× the noise floor (10th-percentile frame RMS) and at least 4% of the loud-end (95th percentile)
 * level; gaps shorter than `minGapMs` are bridged, bursts shorter than `minBurstMs` dropped.
 * `mask` ranges (e.g. the DTMF tone) are ignored.
 */
export function findBursts(x, sr, { frameMs = 20, minGapMs = 300, minBurstMs = 150, mask = [] } = {}) {
  const frame = Math.round((sr * frameMs) / 1000);
  const n = Math.floor(x.length / frame);
  const rms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let p = 0;
    for (let i = 0; i < frame; i++) p += x[f * frame + i] ** 2;
    rms[f] = Math.sqrt(p / frame);
  }
  const sorted = Float64Array.from(rms).sort();
  const floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.95)] || 0;
  const thr = Math.max(floor * 3, loud * 0.04, 1e-4);
  const masked = f => mask.some(([a, b]) => (f + 1) * frame / sr > a && f * frame / sr < b);
  const raw = [];
  for (let f = 0; f < n; f++) {
    if (rms[f] < thr || masked(f)) continue;
    const start = (f * frame) / sr, end = ((f + 1) * frame) / sr;
    const last = raw.at(-1);
    if (last && start - last.end < minGapMs / 1000) last.end = end; else raw.push({ start, end });
  }
  return raw.filter(b => (b.end - b.start) * 1000 >= minBurstMs);
}

// ── Align with the server's turns ────────────────────────────────────────────

/** Accepts the raw API response, its `data`, or a bare turns array. */
export function turnsOf(json) {
  const turns = Array.isArray(json) ? json : (json?.data?.turns ?? json?.turns);
  if (!Array.isArray(turns) || !turns.length) throw new Error('no turns found in the JSON (expected the /admin/calls/:callSid/turns response)');
  return { turns, syncDtmfAt: (json?.data ?? json)?.sync_dtmf_at ?? turns[0].sync_dtmf_at ?? null, provider: turns[0].provider };
}

/**
 * Per turn: the caller's last burst end before the server's end-of-speech, the first burst after
 * it (the reply), and the heard latency between them, next to the server's own speech_end →
 * first_sent. Alignment by the DTMF marker only chooses *which* bursts belong to a turn; the
 * heard latency itself is measured inside the recording, so a small alignment error doesn't move it.
 */
export function perTurn(bursts, turns, { dtmfAt, syncDtmfAt, tolS = 0.6, lookBackS = 5 }) {
  const toRec = ms => dtmfAt + (ms - syncDtmfAt) / 1000;
  return turns.map(t => {
    const serverEnd = toRec(t.started_at);
    const ci = bursts.findLastIndex(b => b.end <= serverEnd + tolS && b.end >= serverEnd - lookBackS);
    const caller = bursts[ci], reply = bursts[ci + 1];
    const serverMs = t.t_first_sent === null || t.t_first_sent === undefined ? null : t.t_first_sent - t.t_speech_end;
    const row = { turn: t.turn_n, serverMs, endpointingMs: t.endpointing_ms ?? null, callerEnd: caller?.end ?? null, replyStart: reply?.start ?? null, heardMs: null, diffMs: null, note: '' };
    if (!caller) row.note = 'no caller speech found before this turn';
    else if (!reply) row.note = 'no reply found after caller speech';
    else if (ci + 1 < bursts.length && reply.start - caller.end > 8) row.note = 'reply too late: probably a different turn';
    else {
      row.heardMs = Math.round((reply.start - caller.end) * 1000);
      if (serverMs !== null) row.diffMs = row.heardMs - serverMs;
    }
    return row;
  });
}

export function formatTable(rows, provider) {
  const f = v => (v === null || v === undefined ? '—' : String(v));
  const head = ['turn', 'heard ms', 'server ms', 'diff ms', 'endpointing', 'diff − endpointing', 'note'];
  const lines = rows.map(r => [r.turn, f(r.heardMs), f(r.serverMs), f(r.diffMs), f(r.endpointingMs), r.diffMs !== null && r.endpointingMs !== null ? r.diffMs - r.endpointingMs : '—', r.note]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map(l => String(l[i]).length)));
  const fmt = l => l.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [`carrier: ${provider ?? '?'}`, fmt(head), fmt(w.map(n => '-'.repeat(n))), ...lines.map(fmt),
    '',
    'heard      = caller finished speaking → first audible reply, measured in the recording.',
    'server     = server speech_end → first audio frame written to the carrier (t_first_sent).',
    'diff       = heard − server: the endpoint wait the server does not count + carrier and network delay, both ways.',
    'Not shown: playback finished (carrier-confirmed) is when playback ENDED, never when sound first became audible.'].join('\n');
}
