// Per-turn latency timeline and cost counters.
//
// One TurnTimeline per caller turn, built by CallRelay from timestamps it
// already has at hand (performance.now(); no extra I/O on the call's path).
// All times are ms offsets from t=0, which is the moment the STT reported the
// end of the caller's speech (t_speech_end is therefore 0 by definition, and
// `end_signal` says which STT signal that was). Rows are written once, after
// the call, via ctx.waitUntil — see CallRelay.flushTurnMetrics. Table:
// call_turn_metrics (drizzle/0029_call_turn_metrics.sql).
//
// What the stamps mean (see docs/latency-handset-test.md):
//   t_first_sent      first audio frame written to the carrier socket. NOT when the caller hears it.
//   t_playback_done   "playback finished (carrier-confirmed)": the carrier echoed our checkpoint
//                     after the reply's last chunk (Twilio/Exotel `mark`, Plivo `playedStream`).
//                     It is when playback ended, NOT when the first sound became audible.

import type { Env } from '../types';

export type Stamp = 'final' | 'firstPhrase' | 'firstTts' | 'firstSent' | 'firstFillerSent' | 'playbackDone';

export interface ToolTiming { name: string; start: number; end: number; ok: boolean }

export class TurnTimeline {
  /** performance.now() at t=0 (the STT end-of-speech signal). */
  readonly t0: number;
  /** Wall clock (epoch ms) at t=0. */
  readonly startedAt: number;
  readonly stamps: Partial<Record<Stamp, number>> = {};
  readonly tools: ToolTiming[] = [];
  endSignal: string;
  sttAudioS = 0;
  ttsChars = 0;
  bargeIn = false;
  outcome = 'done';
  cachedAudio = false;
  audioCache: string | null = null;

  constructor(finalAt: number, end?: { signal: string; at: number }) {
    this.t0 = end ? Math.min(end.at, finalAt) : finalAt;
    this.startedAt = Date.now() - Math.round(performance.now() - this.t0);
    this.endSignal = end?.signal ?? 'unknown';
    this.stamps.final = this.rel(finalAt);
  }

  rel(perfNow = performance.now()): number { return Math.max(0, Math.round(perfNow - this.t0)); }

  /** Records the stamp the first time only. */
  once(k: Stamp, perfNow = performance.now()) { if (this.stamps[k] === undefined) this.stamps[k] = this.rel(perfNow); }

  tool(name: string, startAbs: number, endAbs: number, ok: boolean) {
    if (this.tools.length < 20) this.tools.push({ name, start: this.rel(startAbs), end: this.rel(endAbs), ok });
  }
}

export interface TurnRowContext {
  callSid: string; businessType: string; provider: string; turnN: number;
  sttProvider: string; ttsProvider: string; llmModel: string;
  endpointingMs: number | null; syncDtmfAt: number | null;
}

/** One row per turn, as stored and as returned by GET /admin/calls/:callSid/turns. */
export interface TurnRow {
  call_sid: string; business_type: string; provider: string; turn_n: number;
  started_at: number; end_signal: string; endpointing_ms: number | null;
  t_speech_end: number; t_final: number | null; t_first_phrase: number | null; t_first_tts: number | null;
  t_first_sent: number | null; t_first_filler_sent: number | null; t_playback_done: number | null;
  tools: ToolTiming[];
  stt_audio_s: number; tts_chars: number; reply_used_cached_audio: boolean; audio_cache: string | null;
  barge_in: boolean; outcome: string;
  stt_provider: string; tts_provider: string; llm_model: string; sync_dtmf_at: number | null;
}

export function toRow(tl: TurnTimeline, c: TurnRowContext): TurnRow {
  const s = tl.stamps;
  return {
    call_sid: c.callSid, business_type: c.businessType, provider: c.provider, turn_n: c.turnN,
    started_at: tl.startedAt, end_signal: tl.endSignal, endpointing_ms: c.endpointingMs,
    t_speech_end: 0, t_final: s.final ?? null, t_first_phrase: s.firstPhrase ?? null, t_first_tts: s.firstTts ?? null,
    t_first_sent: s.firstSent ?? null, t_first_filler_sent: s.firstFillerSent ?? null,
    // An interrupted reply was not played to its end, whatever the last echo was.
    t_playback_done: tl.bargeIn ? null : s.playbackDone ?? null,
    tools: tl.tools,
    stt_audio_s: Math.round(tl.sttAudioS * 100) / 100, tts_chars: tl.ttsChars,
    reply_used_cached_audio: tl.cachedAudio, audio_cache: tl.audioCache,
    barge_in: tl.bargeIn, outcome: tl.outcome,
    stt_provider: c.sttProvider, tts_provider: c.ttsProvider, llm_model: c.llmModel, sync_dtmf_at: c.syncDtmfAt,
  };
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);

/** Derived segment durations (ms); null when either end is missing. */
export function segments(r: Pick<TurnRow, 't_speech_end' | 't_final' | 't_first_phrase' | 't_first_tts' | 't_first_sent'>) {
  return {
    speech_end_to_final: diff(r.t_speech_end, r.t_final),
    final_to_first_phrase: diff(r.t_final, r.t_first_phrase),
    first_phrase_to_first_tts: diff(r.t_first_phrase, r.t_first_tts),
    first_tts_to_first_sent: diff(r.t_first_tts, r.t_first_sent),
    speech_end_to_first_sent: diff(r.t_speech_end, r.t_first_sent),
  };
}

/** One compact JSON line per turn, for `wrangler tail`. */
export function timelineLog(r: TurnRow) {
  return {
    call: r.call_sid.slice(-8), n: r.turn_n, carrier: r.provider, sig: r.end_signal,
    t: { final: r.t_final, phrase: r.t_first_phrase, tts: r.t_first_tts, sent: r.t_first_sent, filler: r.t_first_filler_sent },
    seg: segments(r), tools: r.tools.map(t => `${t.name}:${t.end - t.start}${t.ok ? '' : '!'}`),
    stt_s: r.stt_audio_s, tts_chars: r.tts_chars, cached: r.reply_used_cached_audio, barge: r.barge_in, out: r.outcome,
    stt: r.stt_provider, tts: r.tts_provider, llm: r.llm_model,
  };
}

const COLS = ['id', 'call_sid', 'business_type', 'provider', 'turn_n', 'started_at', 'end_signal', 'endpointing_ms',
  't_speech_end', 't_final', 't_first_phrase', 't_first_tts', 't_first_sent', 't_first_filler_sent', 't_playback_done',
  'tools', 'stt_audio_s', 'tts_chars', 'cached_audio', 'audio_cache', 'barge_in', 'outcome',
  'stt_provider', 'tts_provider', 'llm_model', 'sync_dtmf_at', 'created_at'] as const;

/** Writes a call's turn rows in one D1 batch. Callers run it under waitUntil and swallow errors. */
export async function saveTurnRows(env: Env, rows: TurnRow[]): Promise<void> {
  if (!rows.length) return;
  const sql = `INSERT OR REPLACE INTO call_turn_metrics (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(rows.map(r => env.DB.prepare(sql).bind(
    `${r.call_sid}:${r.turn_n}`, r.call_sid, r.business_type, r.provider, r.turn_n, r.started_at, r.end_signal, r.endpointing_ms,
    r.t_speech_end, r.t_final, r.t_first_phrase, r.t_first_tts, r.t_first_sent, r.t_first_filler_sent, r.t_playback_done,
    JSON.stringify(r.tools), r.stt_audio_s, r.tts_chars, r.reply_used_cached_audio ? 1 : 0, r.audio_cache, r.barge_in ? 1 : 0, r.outcome,
    r.stt_provider, r.tts_provider, r.llm_model, r.sync_dtmf_at, now,
  )));
}

/** A D1 row back into the API shape. */
export function fromDb(d: Record<string, any>): TurnRow {
  let tools: ToolTiming[] = [];
  try { tools = JSON.parse(d.tools ?? '[]'); } catch { /* keep [] */ }
  return {
    call_sid: d.call_sid, business_type: d.business_type, provider: d.provider, turn_n: d.turn_n,
    started_at: d.started_at, end_signal: d.end_signal, endpointing_ms: d.endpointing_ms ?? null,
    t_speech_end: d.t_speech_end, t_final: d.t_final ?? null, t_first_phrase: d.t_first_phrase ?? null, t_first_tts: d.t_first_tts ?? null,
    t_first_sent: d.t_first_sent ?? null, t_first_filler_sent: d.t_first_filler_sent ?? null, t_playback_done: d.t_playback_done ?? null,
    tools, stt_audio_s: d.stt_audio_s, tts_chars: d.tts_chars, reply_used_cached_audio: !!d.cached_audio, audio_cache: d.audio_cache ?? null,
    barge_in: !!d.barge_in, outcome: d.outcome,
    stt_provider: d.stt_provider, tts_provider: d.tts_provider, llm_model: d.llm_model, sync_dtmf_at: d.sync_dtmf_at ?? null,
  };
}

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return Math.round(sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo));
}

type Stat = { n: number; p50: number | null; p90: number | null; p95: number | null };
const SEGS = ['speech_end_to_final', 'final_to_first_phrase', 'first_phrase_to_first_tts', 'first_tts_to_first_sent', 'speech_end_to_first_sent'] as const;

function stats(rows: TurnRow[]): Record<string, Stat> {
  const out: Record<string, Stat> = {};
  const all = rows.map(segments);
  const extra: [string, (number | null)[]][] = [
    ['speech_end_to_playback_done', rows.map(r => r.t_playback_done)],
  ];
  const series: [string, (number | null)[]][] = [...SEGS.map(k => [k, all.map(s => s[k])] as [string, (number | null)[]]), ...extra];
  for (const [k, vals] of series) {
    const v = vals.filter((x): x is number => x !== null).sort((a, b) => a - b);
    out[k] = { n: v.length, p50: percentile(v, 0.5), p90: percentile(v, 0.9), p95: percentile(v, 0.95) };
  }
  return out;
}

/** p50/p90/p95 per segment, overall and per carrier. */
export function latencyReport(rows: TurnRow[]) {
  const carriers = [...new Set(rows.map(r => r.provider))].sort();
  return {
    turns: rows.length,
    segments: stats(rows),
    by_carrier: Object.fromEntries(carriers.map(c => [c, { turns: rows.filter(r => r.provider === c).length, segments: stats(rows.filter(r => r.provider === c)) }])),
  };
}
