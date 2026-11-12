import { useEffect, useMemo, useState } from 'react';
import { formatPhone, type SectorLocale } from '../locale';
import { Badge, Button, Card, EmptyState, Notice, ViewToggle } from '../components/ui';
import { Feed, TranscriptDialog } from '../components/Activity';
import { buildActivity, formatWhen, loadBusinessData, type Activity, type BusinessData, type MessageRow } from '../lib/activity';

interface SectorOption extends SectorLocale { key: string; name: string }

interface Props {
  base: string;
  auth: Record<string, string>;
  /** The business being viewed (one entry). */
  sectors: SectorOption[];
  /** Operator: show per-turn latency in transcripts. */
  operator?: boolean;
}

type Filter = 'all' | 'call' | 'whatsapp';

// Messages waiting for a call back, then every recent call and WhatsApp chat.
export default function Calls({ base, auth, sectors, operator = false }: Props) {
  const biz = sectors[0];
  const [data, setData] = useState<BusinessData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Activity | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (!biz || !Object.keys(auth).length) return;
    let live = true;
    setData(null); setError('');
    loadBusinessData(base, auth, biz.key).then(d => live && setData(d)).catch((e: Error) => live && setError(e.message || 'Could not load calls'));
    return () => { live = false; };
  }, [base, auth, biz?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const activity = useMemo(() => (data ? buildActivity(data.transcripts, data.bookings, data.messages, biz?.locale) : []), [data, biz?.locale]);
  const shown = filter === 'all' ? activity : activity.filter(a => a.channel === filter);
  const waiting = data?.messages.filter(m => m.status !== 'DONE') ?? [];
  const messages = showDone ? data?.messages ?? [] : waiting;

  const markDone = (m: MessageRow) => {
    const status = m.status === 'DONE' ? 'NEW' : 'DONE';
    fetch(`${base}/admin/messages/${m.businessType}/${m.id}`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    }).then(() => setData(d => d && { ...d, messages: d.messages.map(x => (x.id === m.id ? { ...x, status } : x)) }));
  };

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="muted" role="status">Loading…</p>;

  return (
    <>
      <Card
        title={<>Messages to call back {waiting.length > 0 && <Badge tone="warning">{waiting.length} waiting</Badge>}</>}
        description="Callers who asked to be called back. Mark each one done once you've called."
        actions={data.messages.length > waiting.length && <Button variant="ghost" size="sm" onClick={() => setShowDone(s => !s)}>{showDone ? 'Hide done' : 'Show done'}</Button>}
      >
        {messages.length === 0 ? <EmptyState title="No messages waiting">You're all caught up.</EmptyState> : (
          <ul className="feed">
            {messages.map(m => (
              <li key={m.id} className={`msg${m.status === 'DONE' ? ' done' : ''}`}>
                <div className="feed-main">
                  <span className="feed-top">
                    <span className="feed-who">{m.callerName ?? 'Caller'}</span>
                    {m.callbackPhone ? <a href={`tel:${m.callbackPhone}`}>{formatPhone(m.callbackPhone)}</a> : <span className="muted small">no number</span>}
                    <span className="feed-when">{formatWhen(m.createdAt)}</span>
                  </span>
                  <span>{m.message}</span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => markDone(m)}>{m.status === 'DONE' ? 'Reopen' : 'Mark done'}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        className="card-flush"
        title="Recent calls and chats"
        description="Newest first. Calls aren't recorded; only the text of each conversation is kept."
        actions={<ViewToggle label="Show" value={filter} onChange={setFilter} options={[{ key: 'all', label: 'All' }, { key: 'call', label: 'Calls' }, { key: 'whatsapp', label: 'WhatsApp' }]} />}
      >
        {shown.length === 0
          ? <EmptyState title="No conversations yet">Use “Try your assistant” to make a test call.</EmptyState>
          : <Feed items={shown} onOpen={setOpen} />}
      </Card>

      {open && <TranscriptDialog a={open} showLatency={operator} onClose={() => setOpen(null)} />}
    </>
  );
}
