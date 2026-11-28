// Aggregates for scripts/voice-quality-report.mjs: pure functions over the JSON of
// GET /admin/calls and GET /admin/calls/:sid/turns. Numbers and short trigger words only;
// never a transcript, a name or a phone number (the inputs don't carry any).

const REASON_LABEL = { stop_word: '1-word stop', enough_words: 'interim words', vad: 'VAD', transcript: 'final transcript' };
const word = w => String(w ?? '').toLowerCase().slice(0, 12);

export function percentile(values, p) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}
const avg = v => { const a = v.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

/** One call: `outcome` is a row of /admin/calls, `data` the payload of /admin/calls/:sid/turns. */
export function summariseCall(outcome, data, language = null) {
  const turns = data?.turns ?? [];
  const reasons = {};
  const triggers = {}, skippedWords = {};
  let withdrawn = 0, echoFiltered = 0, skippedTotal = 0;
  for (const t of turns) {
    const b = t.barge;
    if (t.barge_in) {
      const label = REASON_LABEL[b?.reason] ?? (b?.reason || 'unknown');
      reasons[label] = (reasons[label] ?? 0) + 1;
      if (b?.word) triggers[word(b.word)] = (triggers[word(b.word)] ?? 0) + 1;
    }
    if (b?.withdrawn) withdrawn++;
    for (const s of b?.skipped ?? []) {
      skippedTotal++;
      if (s.reason === 'echo') echoFiltered++;
      if (s.word) skippedWords[word(s.word)] = (skippedWords[word(s.word)] ?? 0) + 1;
    }
  }
  // Speaking rate: characters sent to the voice per second the reply took to play, on replies that played to the end.
  // It includes the gaps between sentences, so it reads a little low; compare before and after, not against a fixed number.
  const rates = turns
    .filter(t => t.outcome === 'done' && !t.reply_used_cached_audio && t.tts_chars > 20 && t.t_first_sent != null && t.t_playback_done != null && t.t_playback_done > t.t_first_sent)
    .map(t => t.tts_chars / ((t.t_playback_done - t.t_first_sent) / 1000));
  return {
    callId: String(outcome.call_sid ?? data?.call_sid ?? '').slice(-8),
    carrier: data?.provider ?? outcome.carrier ?? null,
    language,
    endReason: data?.end_reason ?? outcome.end_reason ?? null,
    durationS: data?.duration_seconds ?? outcome.duration_seconds ?? null,
    turns: turns.length,
    bargeIns: turns.filter(t => t.barge_in).length,
    reasons, withdrawn, echoFiltered, skippedTotal,
    avgEndpointingMs: avg(turns.map(t => t.endpointing_ms)),
    gapP50Ms: percentile(turns.map(t => t.t_first_sent == null ? NaN : t.t_first_sent - (t.t_speech_end ?? 0)), 0.5),
    charsPerSecP50: percentile(rates, 0.5),
    triggers, skippedWords,
  };
}

const top = (map, n = 10) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
const f = (v, d = 0) => v == null ? '–' : Number(v).toFixed(d);

export function summariseAll(calls) {
  const sum = k => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
  const merge = k => calls.reduce((m, c) => { for (const [w, n] of Object.entries(c[k])) m[w] = (m[w] ?? 0) + n; return m; }, {});
  const reasons = merge('reasons');
  return {
    calls: calls.length, turns: sum('turns'), bargeIns: sum('bargeIns'), withdrawn: sum('withdrawn'), echoFiltered: sum('echoFiltered'), skipped: sum('skippedTotal'),
    reasons, triggers: top(merge('triggers')), skippedWords: top(merge('skippedWords')),
    avgEndpointingMs: avg(calls.map(c => c.avgEndpointingMs)),
    gapP50Ms: percentile(calls.map(c => c.gapP50Ms), 0.5),
    charsPerSecP50: percentile(calls.map(c => c.charsPerSecP50), 0.5),
  };
}

export function renderReport({ business, days, settings, calls }) {
  const t = summariseAll(calls);
  const out = [];
  out.push(`Voice quality report: ${business}, last ${days} day(s)`);
  if (settings) out.push(`Settings now: speed ${settings.speakingRate}, interruptions ${settings.interruptionSensitivity}, endpointing ${settings.endpointing}, noise reduction ${settings.noiseCancellation ? 'on' : 'off'}`);
  out.push('');
  out.push('call      carrier   lang   ended          dur(s) turns barge  withdrawn echo  endpt(ms) gap p50(ms) chars/s  barge reasons');
  for (const c of calls) {
    const why = Object.entries(c.reasons).map(([k, n]) => `${k}×${n}`).join(', ') || '–';
    out.push([c.callId.padEnd(9), String(c.carrier ?? '–').padEnd(9), String(c.language ?? '–').padEnd(6), String(c.endReason ?? '–').padEnd(14),
      f(c.durationS).padStart(6), String(c.turns).padStart(5), String(c.bargeIns).padStart(5), String(c.withdrawn).padStart(9), String(c.echoFiltered).padStart(4),
      f(c.avgEndpointingMs).padStart(9), f(c.gapP50Ms).padStart(11), f(c.charsPerSecP50, 1).padStart(7), ' ' + why].join(' '));
  }
  out.push('');
  out.push(`TOTALS  ${t.calls} calls, ${t.turns} caller turns`);
  out.push(`  barge-ins: ${t.bargeIns} (${t.turns ? Math.round(100 * t.bargeIns / t.turns) : 0}% of turns)  by reason: ${Object.entries(t.reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out.push(`  replies withdrawn by the 2-second rule: ${t.withdrawn}   interruptions skipped: ${t.skipped} (echo-filtered ${t.echoFiltered})`);
  out.push(`  average endpointing: ${f(t.avgEndpointingMs)} ms   caller-stops-to-first-audio p50: ${f(t.gapP50Ms)} ms   speaking rate p50: ${f(t.charsPerSecP50, 1)} characters/second`);
  out.push(`  top words that cut the assistant off: ${t.triggers.map(([w, n]) => `${w} ×${n}`).join(', ') || 'none recorded'}`);
  out.push(`  top words heard but ignored:          ${t.skippedWords.map(([w, n]) => `${w} ×${n}`).join(', ') || 'none recorded'}`);
  out.push('');
  out.push('Reading it: many "interim words"/"1-word stop" barge-ins on short replies, or a high withdrawn count, means noise or backchannels are cutting in;');
  out.push('an endpointing under ~400 ms with a short gap means the assistant answers inside the caller\'s pauses; a high characters/second means fast speech.');
  out.push('Trigger words and the withdrawn count are only recorded for calls made after this change shipped; older calls show none/0.');
  return out.join('\n');
}
