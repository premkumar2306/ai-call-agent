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
export function TranscriptDialog({ a, showLatency, onClose }: { a: Activity; showLatency?: boolean; onClose: () => void }) {
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
