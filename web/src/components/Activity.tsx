import { Fragment, useEffect, useState } from 'react';
import { Badge, Dialog } from './ui';
import { CHANNEL_ICON, CHANNEL_NAME, OUTCOME, formatDuration, formatWhen, type Activity, type TurnMetric } from '../lib/activity';

/** A list of recent conversations; each opens its transcript. */
export function Feed({ items, onOpen }: { items: Activity[]; onOpen: (a: Activity) => void }) {
  return (
    <ul className="feed">
      {items.map(a => (
        <li key={a.t.id}>
          <button type="button" className="feed-item" onClick={() => onOpen(a)}>
            <span className={`feed-icon${a.channel === 'whatsapp' ? ' wa' : ''}`} role="img" aria-label={CHANNEL_NAME[a.channel]}>{CHANNEL_ICON[a.channel]}</span>
            <span className="feed-main">
              <span className="feed-top">
                <span className="feed-who">{a.who}</span>
                <Badge tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].label}</Badge>
                <span className="feed-when">{formatWhen(a.t.createdAt)}</span>
              </span>
              <span className="feed-summary">{a.summary}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The full conversation, with per-turn latency when the call relay recorded it. */
export function TranscriptDialog({ a, showLatency, base, auth, onClose }: { a: Activity; showLatency?: boolean; base?: string; auth?: Record<string, string>; onClose: () => void }) {
  const { t } = a;
  const dur = formatDuration(t.createdAt, t.updatedAt);
  return (
    <Dialog
      title={a.who}
      subtitle={<>{CHANNEL_ICON[a.channel]} {CHANNEL_NAME[a.channel]} · {formatWhen(t.createdAt)}{dur ? ` · ${dur}` : ''}</>}
      onClose={onClose}
    >
      <div className="row">
        <Badge tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].label}</Badge>
        <span className="muted small">{a.summary}</span>
      </div>
      {showLatency && t.metrics && t.metrics.length > 0 && (
        <details className="more">
          <summary>Response time per turn</summary>
          <LatencyChart metrics={t.metrics} />
        </details>
      )}
      {showLatency && t.callSid && base && auth && (
        <details className="more">
          <summary>Turn timeline</summary>
          <TurnTimeline base={base} auth={auth} callSid={t.callSid} texts={t.metrics?.map(m => m.text)} />
        </details>
      )}
      <div className="chat">
        {t.turns.map((turn, i) => (
          <div key={i} className={`bubble ${turn.role === 'user' ? 'me' : 'them'}`}>
            <span className="who">{turn.role === 'user' ? 'Caller' : 'Assistant'}</span>
            {turn.content}
          </div>
        ))}
      </div>
      {showLatency && t.callSid && <p className="subtle small mono">{t.callSid}</p>}
    </Dialog>
  );
}

// Time to first audio per turn, split into model / tools / speech. Bar widths
// are data, so they are the one place a style attribute is used.
function LatencyChart({ metrics }: { metrics: TurnMetric[] }) {
  const max = Math.max(1, ...metrics.map(m => m.firstAudio ?? 0));
  const lap = (m: TurnMetric, pre: string) => m.laps.filter(l => l[0].startsWith(pre));
  return (
    <div className="stack-sm">
      {metrics.map(m => {
        const total = m.firstAudio ?? 0;
        const firstToken = lap(m, 'anthropic#0 first-token')[0]?.[1] ?? lap(m, 'anthropic#0 (')[0]?.[1] ?? 0;
        const toolEnd = lap(m, 'tools#').slice(-1)[0]?.[1];
        const toolStart = lap(m, 'anthropic#0 (')[0]?.[1] ?? 0;
        const tools = toolEnd ? Math.max(0, toolEnd - toolStart) : 0;
        const model = Math.min(total, firstToken + (toolEnd ? (lap(m, 'anthropic#1 first-token')[0]?.[1] ?? toolEnd) - toolEnd : 0));
        const speech = Math.max(0, total - model - tools);
        const w = (ms: number) => ({ width: `${(ms / max) * 100}%` });
        return (
          <div key={m.n} className="lat-row">
            <div className="lat-text small muted">{m.n}. “{m.text}”{m.fillers ? ` · ${m.fillers} filler` : ''}{m.outcome !== 'done' ? ` · ${m.outcome}` : ''}</div>
            <div className="lat-bar">
              <div className="lat-model" title={`model ${model}ms`} style={w(model)} />
              <div className="lat-tools" title={`tools ${tools}ms`} style={w(tools)} />
              <div className="lat-speech" title={`speech ${speech}ms`} style={w(speech)} />
            </div>
            <div className={`lat-total small ${total > 1500 ? 'bad' : ''}`}>{m.firstAudio != null ? `${(total / 1000).toFixed(2)}s` : '—'}</div>
          </div>
        );
      })}
      <p className="small muted">
        <span className="lat-key lat-model" /> model <span className="lat-key lat-tools" /> tools <span className="lat-key lat-speech" /> speech start.
        Time from the caller's words to the first audio, not counting end-of-speech detection.
      </p>
    </div>
  );
}

export const LONG_CALL_S = 10 * 60;
const BARGE_REASON: Record<string, string> = { stop_word: 'stop word', enough_words: 'several words', transcript: 'final transcript', vad: 'voice detected' };
export const END_REASON: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  caller_hangup: { label: 'caller hung up', tone: 'info' }, agent_hangup: { label: 'agent ended', tone: 'success' },
  transfer: { label: 'transferred', tone: 'success' }, silence: { label: 'silence', tone: 'warning' },
  max_duration: { label: 'max duration', tone: 'danger' }, dead_media: { label: 'no audio', tone: 'danger' }, error: { label: 'error', tone: 'danger' },
};
export function EndReasonTag({ reason }: { reason: string }) {
  const e = END_REASON[reason] ?? { label: reason, tone: 'info' as const };
  return <Badge tone={e.tone}>{e.label}</Badge>;
}

interface TimelineTurn {
  turn_n: number; provider: string; end_signal: string; t_final: number | null; t_first_phrase: number | null;
  t_first_tts: number | null; t_first_sent: number | null; t_playback_done: number | null;
  tools: { name: string; start: number; end: number; ok: boolean }[];
  stt_audio_s: number; tts_chars: number; barge_in: boolean; reply_used_cached_audio: boolean;
  barge?: { decisions: number; interrupts: number; reason?: string; clearMs?: number; clearAcked?: boolean; ttsDropped: number; playedAfterClear: number; skipped: { reason: string; words: number }[] } | null;
  stt_provider: string; tts_provider: string; llm_model: string;
  llm_in: number; llm_out: number; llm_cache_read: number; llm_cache_write: number;
  cost: Cost;
}
// AI cost (listening + model + speaking) at billing rates; the phone line is billed per call minute, not per turn.
interface Cost { total_usd_micros: number; total_inr_paise: number; stt_usd_micros: number; tts_usd_micros: number; llm_usd_micros: number }
interface CallTotal extends Cost { stt_seconds: number; tts_chars: number; llm_in: number; llm_out: number }

const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;
const inr = (micros: number, rate: number) => { const r = (micros / 1e6) * rate; return `₹${r.toFixed(r < 1 ? 3 : 2)}`; };
const num = (n: number) => n.toLocaleString('en-IN');

// Where one reply's time went, in ms after the caller stopped speaking.
const STAGES = [
  { key: 'stt', label: 'Transcript', hint: 'waiting for the words', cls: 'tl-stt' },
  { key: 'model', label: 'Model', hint: 'thinking up the reply', cls: 'tl-model' },
  { key: 'tools', label: 'Tools', hint: 'looking things up', cls: 'tl-tools' },
  { key: 'voice', label: 'Voice', hint: 'turning it into audio', cls: 'tl-voice' },
] as const;
type StageKey = typeof STAGES[number]['key'];

function stagesOf(r: TimelineTurn): (Record<StageKey, number> & { total: number }) | null {
  if (r.t_final === null || r.t_first_phrase === null || r.t_first_sent === null) return null;
  const think = Math.max(0, r.t_first_phrase - r.t_final);
  const tools = Math.min(think, r.tools.reduce((n, x) => n + Math.max(0, x.end - x.start), 0));
  return { stt: r.t_final, model: think - tools, tools, voice: Math.max(0, r.t_first_sent - r.t_first_phrase), total: r.t_first_sent };
}

const sec = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };

// Per-turn timeline from GET /admin/calls/:callSid/turns (operator key). Each reply is one bar split into
// where the time went; tap a turn for the exact numbers. Only calls made after timelines shipped have rows.
// Bar widths are data, so they are the one place a style attribute is used (as in LatencyChart).
function TurnTimeline({ base, auth, callSid, texts }: { base: string; auth: Record<string, string>; callSid: string; texts?: string[] }) {
  const [turns, setTurns] = useState<TimelineTurn[] | null | 'none'>(null);
  const [meta, setMeta] = useState<{ total: CallTotal; rate: number } | null>(null);
  const [ended, setEnded] = useState<{ reason: string | null; seconds: number | null; carrierSeconds: number | null; hangup: string | null }>({ reason: null, seconds: null, carrierSeconds: null, hangup: null });
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${base}/admin/calls/${encodeURIComponent(callSid)}/turns`, { headers: auth })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!live) return;
        setEnded({ reason: j?.data?.end_reason ?? null, seconds: j?.data?.duration_seconds ?? null, carrierSeconds: j?.data?.carrier_duration_seconds ?? null, hangup: j?.data?.hangup_method ?? null });
        setMeta(j?.data?.total ? { total: j.data.total, rate: j.data.usd_to_inr ?? 88 } : null);
        setTurns(j?.data?.turns?.length ? j.data.turns : 'none');
      })
      .catch(() => { if (live) setTurns('none'); });
    return () => { live = false; };
  }, [base, callSid]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (turns === null) return <p className="muted small" role="status">Loading…</p>;
  if (turns === 'none') return <p className="muted small">No timeline for this call (it was made before timelines were recorded).</p>;

  const rows = turns.map(r => ({ r, st: stagesOf(r) }));
  const replied = rows.filter((x): x is { r: TimelineTurn; st: NonNullable<ReturnType<typeof stagesOf>> } => x.st !== null);
  const max = Math.max(1, ...rows.map(x => x.st?.total ?? x.r.t_final ?? 0));
  const slowest = replied.reduce<typeof replied[number] | null>((m, x) => (!m || x.st.total > m.st.total ? x : m), null);
  const avg = (k: StageKey) => (replied.length ? replied.reduce((n, x) => n + x.st[k], 0) / replied.length : 0);
  const biggest = STAGES.reduce((m, s) => (avg(s.key) > avg(m.key) ? s : m), STAGES[0]);
  const first = turns[0];
  const w = (ms: number) => ({ width: `${(ms / max) * 100}%` });

  return (
    <div className="stack-sm">
      <p className="small muted">{first.provider} · speech {first.stt_provider} · voice {first.tts_provider} · {first.llm_model}</p>
      {replied.length > 0 && slowest && (
        <div className="tl-sum">
          <div><span className="tl-num">{sec(median(replied.map(x => x.st.total)))}</span><span className="small muted">typical reply</span></div>
          <div><span className={`tl-num ${slowest.st.total > 1500 ? 'bad' : ''}`}>{sec(slowest.st.total)}</span><span className="small muted">slowest, turn {slowest.r.turn_n}</span></div>
          <div><span className="tl-num">{biggest.label}</span><span className="small muted">biggest share, {sec(avg(biggest.key))} avg</span></div>
        </div>
      )}
      {(ended.reason || (ended.seconds ?? 0) > LONG_CALL_S || ended.carrierSeconds != null || ended.hangup) && (
        <p className="small">
          {ended.reason && <EndReasonTag reason={ended.reason} />}{' '}
          {(ended.seconds ?? 0) > LONG_CALL_S && <span className="bad">Long call: {Math.round((ended.seconds ?? 0) / 60)} min</span>}
          {ended.carrierSeconds != null && <span className="muted"> Ours {ended.seconds ?? '?'}s · carrier {ended.carrierSeconds}s.</span>}
          {ended.hangup && <span className={ended.hangup === 'unconfirmed' ? 'bad' : 'muted'}> Hang-up: {ended.hangup === 'unconfirmed' ? 'NOT confirmed by the carrier' : `confirmed (${ended.hangup.replace('_', ' ')})`}.</span>}
        </p>
      )}
      {meta && (
        <>
          <div className="tl-sum">
            <div><span className="tl-num">{meta.total.stt_seconds.toFixed(1)}s</span><span className="small muted">listening · {inr(meta.total.stt_usd_micros, meta.rate)}</span></div>
            <div><span className="tl-num">{num(meta.total.llm_in + meta.total.llm_out)}</span><span className="small muted">tokens ({num(meta.total.llm_in)} in, {num(meta.total.llm_out)} out) · {inr(meta.total.llm_usd_micros, meta.rate)}</span></div>
            <div><span className="tl-num">{num(meta.total.tts_chars)}</span><span className="small muted">characters spoken · {inr(meta.total.tts_usd_micros, meta.rate)}</span></div>
          </div>
          <p className="small"><strong>AI cost of this call: {inr(meta.total.total_usd_micros, meta.rate)}</strong> <span className="muted">({usd(meta.total.total_usd_micros)}) · speech and model only, not the phone line</span></p>
        </>
      )}
      <div className="tl-legend small muted">
        {STAGES.map(s => <span key={s.key}><i className={`lat-key ${s.cls}`} /> {s.label}</span>)}
      </div>
      <ul className="tl-list">
        {rows.map(({ r, st }) => {
          const open = openTurn === r.turn_n;
          const text = texts?.[r.turn_n - 1];
          return (
            <li key={r.turn_n}>
              <button type="button" className="tl-row" aria-expanded={open} onClick={() => setOpenTurn(open ? null : r.turn_n)}>
                <span className="tl-label small">{r.turn_n}. {text ? `“${text}”` : ''}{r.barge_in ? ` · interrupted${r.barge?.reason ? ` (${BARGE_REASON[r.barge.reason] ?? r.barge.reason})` : ''}` : ''}</span>
                <span className="tl-bar">
                  {st ? STAGES.map(s => <span key={s.key} className={s.cls} title={`${s.label} ${Math.round(st[s.key])}ms`} style={w(st[s.key])} />)
                    : <span className="tl-stt" title={`Transcript ${r.t_final ?? 0}ms`} style={w(r.t_final ?? 0)} />}
                </span>
                <span className={`tl-total small ${st && st.total > 1500 ? 'bad' : ''}`}>{st ? sec(st.total) : 'no reply'}</span>
              </button>
              {open && (
                <dl className="tl-detail small">
                  <dt>Words ready</dt><dd>{r.t_final ?? '—'} ms{st ? ` (${r.end_signal})` : ''}</dd>
                  <dt>First phrase</dt><dd>{r.t_first_phrase ?? '—'} ms</dd>
                  {r.tools.map((x, i) => <Fragment key={i}><dt>Tool</dt><dd>{x.name} · {x.end - x.start} ms{x.ok ? '' : ' · failed'}</dd></Fragment>)}
                  <dt>Audio ready</dt><dd>{r.t_first_tts ?? '—'} ms</dd>
                  <dt>Sent to carrier</dt><dd>{r.t_first_sent ?? '—'} ms</dd>
                  <dt>Playback finished*</dt><dd>{r.t_playback_done === null ? '—' : `${r.t_playback_done} ms (spoke for about ${sec(r.t_playback_done - (r.t_first_sent ?? 0))})`}</dd>
                  {r.barge && <><dt>Barge-in</dt><dd>{r.barge.interrupts ? `interrupted by ${BARGE_REASON[r.barge.reason ?? ''] ?? r.barge.reason}${r.barge.clearMs != null ? `, clear sent ${r.barge.clearMs} ms after the caller started` : ''}${r.barge.clearAcked ? ', carrier confirmed' : ', carrier did not confirm'}${r.barge.playedAfterClear ? `, ${r.barge.playedAfterClear} audio piece(s) played after the clear` : ''}` : 'not interrupted'}{r.barge.skipped.length ? ` · ignored: ${r.barge.skipped.map(s => `${s.reason} (${s.words} word${s.words === 1 ? '' : 's'})`).join(', ')}` : ''}</dd></>}
                  <dt>Listened</dt><dd>{r.stt_audio_s}s of caller audio · {inr(r.cost.stt_usd_micros, meta?.rate ?? 88)}</dd>
                  <dt>Model</dt><dd>{num(r.llm_in + r.llm_cache_read + r.llm_cache_write)} tokens in{r.llm_cache_read ? ` (${num(r.llm_cache_read)} cached)` : ''}, {num(r.llm_out)} out · {inr(r.cost.llm_usd_micros, meta?.rate ?? 88)}</dd>
                  <dt>Spoke</dt><dd>{num(r.tts_chars)} characters · {inr(r.cost.tts_usd_micros, meta?.rate ?? 88)}{r.reply_used_cached_audio ? ' · cached audio' : ''}</dd>
                  <dt>This turn</dt><dd><strong>{inr(r.cost.total_usd_micros, meta?.rate ?? 88)}</strong> ({usd(r.cost.total_usd_micros)})</dd>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
      <p className="small muted">
        Time from when the caller stopped speaking to the first audio leaving our server. *Playback finished is when the
        carrier confirmed the reply was played out, not when the caller first heard it.
      </p>
    </div>
  );
}
