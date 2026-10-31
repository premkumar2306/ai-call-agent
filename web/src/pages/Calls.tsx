import { useState, useEffect } from 'react';

interface Props {
  base: string;
  adminKey: string;
}

interface TranscriptRow {
  id: string;
  callSid: string | null;
  customerIdHashed: string;
  businessType: string;
  turns: Array<{ role: string; content: string }>;
  metrics?: TurnMetric[] | null;
  createdAt: number | string;
  updatedAt?: number | string;
}

// Per-turn timing saved by CallRelay (worker/src/durable-objects/call-relay.ts).
interface TurnMetric {
  n: number;
  at: number;
  text: string;
  queued: number;
  laps: [string, number][];
  firstAudio?: number;
  fillers: number;
  outcome: 'done' | 'interrupted' | 'dropped';
}

interface BookingRow {
  id: string;
  businessType: string;
  productName: string;
  status: string;
  scheduledAt: string | null;
  customerName: string | null;
  vehicle: string | null;
  callbackPhone: string | null;
  notes: string | null;
  createdAt: number | string;
}

interface MessageRow {
  id: string;
  businessType: string;
  callerName: string | null;
  callbackPhone: string | null;
  message: string;
  status: string;
  createdAt: number | string;
}

function formatSlot(iso: string | null): string {
  if (!iso) return '—';
  const [d, t] = iso.split('T');
  const date = new Date(`${d}T12:00:00`);
  const [h, m] = t.split(':').map(Number);
  const clock = `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${clock}`;
}

// Time to first audio per turn, split into model / tools / speech, so a slow
// turn shows where the time went.
function LatencyChart({ metrics }: { metrics: TurnMetric[] }) {
  const max = Math.max(1, ...metrics.map(m => m.firstAudio ?? 0));
  const lap = (m: TurnMetric, pre: string) => m.laps.filter(l => l[0].startsWith(pre));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {metrics.map(m => {
        const total = m.firstAudio ?? 0;
        const firstToken = lap(m, 'anthropic#0 first-token')[0]?.[1] ?? lap(m, 'anthropic#0 (')[0]?.[1] ?? 0;
        const toolEnd = lap(m, 'tools#').slice(-1)[0]?.[1];
        const toolStart = lap(m, 'anthropic#0 (')[0]?.[1] ?? 0;
        const tools = toolEnd ? Math.max(0, toolEnd - toolStart) : 0;
        const model = Math.min(total, firstToken + (toolEnd ? (lap(m, 'anthropic#1 first-token')[0]?.[1] ?? toolEnd) - toolEnd : 0));
        const speech = Math.max(0, total - model - tools);
        const w = (ms: number) => `${(ms / max) * 100}%`;
        return (
          <div key={m.n} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 56px', gap: 8, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.n}. “{m.text}”{m.fillers ? ` · ${m.fillers} filler` : ''}{m.outcome !== 'done' ? ` · ${m.outcome}` : ''}
              </div>
              <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#1e1e2e' }}>
                <div title={`model ${model}ms`} style={{ width: w(model), background: '#6c47ff' }} />
                <div title={`tools ${tools}ms`} style={{ width: w(tools), background: '#f59e0b' }} />
                <div title={`speech ${speech}ms`} style={{ width: w(speech), background: '#22c55e' }} />
              </div>
            </div>
            <div style={{ fontSize: 12, color: total > 1500 ? '#f87171' : '#ddd', textAlign: 'right' }}>
              {m.firstAudio != null ? `${(total / 1000).toFixed(2)}s` : '—'}
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: '#777', display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
        <span><span style={{ color: '#6c47ff' }}>■</span> model</span>
        <span><span style={{ color: '#f59e0b' }}>■</span> tools</span>
        <span><span style={{ color: '#22c55e' }}>■</span> speech start</span>
        <span>Time from the caller's words to our first audio. Excludes end-of-speech detection.</span>
      </div>
    </div>
  );
}

interface SectorOption { key: string; name: string }

function toMs(ts: number | string): number {
  return typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
}

function formatDateTime(ts: number | string): string {
  return new Date(toMs(ts)).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(start: number | string, end?: number | string): string | null {
  if (!end) return null;
  const secs = Math.round((toMs(end) - toMs(start)) / 1000);
  if (secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function channelOf(callSid: string | null): 'call' | 'whatsapp' | 'web' {
  if (!callSid) return 'web';
  if (callSid.startsWith('wa:')) return 'whatsapp';
  if (callSid.startsWith('web-')) return 'web';
  return 'call';
}

const CHANNEL_LABEL: Record<string, string> = {
  call: '📞 Call',
  whatsapp: '💬 WhatsApp',
  web: '🌐 Web',
};

const card: React.CSSProperties = {
  background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 'clamp(14px, 4vw, 28px)',
  minWidth: 0, boxSizing: 'border-box',
};
const h2: React.CSSProperties = {
  fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 8, marginTop: 0,
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 12px', fontSize: 12, color: '#888',
  borderBottom: '1px solid #2a2a3a', fontWeight: 600, whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '10px 12px', fontSize: 13, color: '#ddd', borderBottom: '1px solid #1e1e2e',
  verticalAlign: 'top',
};

export default function Calls({ base, adminKey }: Props) {
  const [sectors, setSectors]         = useState<SectorOption[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [openId, setOpenId]           = useState<string | null>(null);
  const [businessFilter, setBusinessFilter] = useState<string>('all');
  const [bookings, setBookings]       = useState<BookingRow[]>([]);
  const [messages, setMessages]       = useState<MessageRow[]>([]);

  useEffect(() => {
    if (!adminKey) {
      setTranscripts([]);
      setError('Enter the admin key above to view call transcripts.');
      return;
    }
    setLoading(true);
    setError('');
    fetch(`${base}/sectors`)
      .then(r => r.json())
      .then(async (json: any) => {
        if (!json.success) { setError('Failed to load business list'); return; }
        const allSectors: SectorOption[] = json.data;
        setSectors(allSectors);

        const getAll = async <T,>(path: string): Promise<T[]> => (await Promise.all(allSectors.map(s =>
          fetch(`${base}/admin/${path}/${s.key}`, { headers: { 'X-Admin-Key': adminKey } })
            .then(r => r.json()).then((j: any) => (j.success ? j.data : []) as T[]).catch(() => [] as T[])
        ))).flat();
        getAll<BookingRow>('bookings').then(rows => setBookings(rows.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))));
        getAll<MessageRow>('messages').then(rows => setMessages(rows.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))));

        const results = await Promise.all(
          allSectors.map(s =>
            fetch(`${base}/admin/transcripts/${s.key}`, { headers: { 'X-Admin-Key': adminKey } })
              .then(async r => {
                const json = await r.json();
                if (!r.ok || !json.success) throw new Error(json.error ?? 'Failed to load transcripts');
                return json.data as TranscriptRow[];
              })
          )
        );
        const merged = results.flat().sort((a, b) => {
          const at = typeof a.createdAt === 'number' ? a.createdAt * 1000 : new Date(a.createdAt).getTime();
          const bt = typeof b.createdAt === 'number' ? b.createdAt * 1000 : new Date(b.createdAt).getTime();
          return bt - at;
        });
        setTranscripts(merged);
      })
      .catch((err: Error) => setError(err.message || 'Network error loading calls'))
      .finally(() => setLoading(false));
  }, [base, adminKey]);

  const sectorName = (key: string) => sectors.find(s => s.key === key)?.name ?? key;
  const visible = businessFilter === 'all' ? transcripts : transcripts.filter(t => t.businessType === businessFilter);
  const open = visible.find(t => t.id === openId) ?? null;
  const inBusiness = <T extends { businessType: string }>(rows: T[]) =>
    businessFilter === 'all' ? rows : rows.filter(r => r.businessType === businessFilter);
  const visibleBookings = inBusiness(bookings).filter(b => b.status !== 'CANCELLED').slice(0, 30);
  const visibleMessages = inBusiness(messages).slice(0, 30);

  const markDone = (m: MessageRow) => {
    fetch(`${base}/admin/messages/${m.businessType}/${m.id}`, {
      method: 'PATCH', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: m.status === 'DONE' ? 'NEW' : 'DONE' }),
    }).then(() => setMessages(ms => ms.map(x => x.id === m.id ? { ...x, status: m.status === 'DONE' ? 'NEW' : 'DONE' } : x)));
  };

  return (
    <div style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 12 }}>
          <h2 style={h2}>All Calls</h2>
          <select
            value={businessFilter}
            onChange={e => setBusinessFilter(e.target.value)}
            style={{ background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '6px 12px', borderRadius: 8, outline: 'none', fontSize: 13 }}
          >
            <option value="all">All businesses</option>
            {sectors.map(s => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>
        </div>
        <p style={{ fontSize: 13, color: '#888', marginTop: 0, marginBottom: 20 }}>
          Audio isn't recorded — STT/TTS streams live and nothing is persisted. Text transcripts only.
        </p>

        {loading && <p style={{ color: '#888', fontSize: 14 }}>Loading…</p>}
        {error   && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}

        {!loading && !error && visible.length === 0 && (
          <p style={{ color: '#888', fontSize: 14 }}>No calls yet.</p>
        )}

        {!loading && !error && visible.length > 0 && (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
            <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Date / Time</th>
                  <th style={th}>Business</th>
                  <th style={th}>Channel</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Turns</th>
                  <th style={th}>Last message</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(t => {
                  const anonId   = t.customerIdHashed.slice(-8);
                  const channel  = channelOf(t.callSid);
                  const lastTurn = [...t.turns].reverse().find(x => x.role === 'assistant');
                  const preview  = lastTurn ? lastTurn.content.slice(0, 60) + (lastTurn.content.length > 60 ? '…' : '') : '—';

                  return (
                    <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(t.id)}>
                      <td style={td}>{formatDateTime(t.createdAt)}</td>
                      <td style={td}>{sectorName(t.businessType)}</td>
                      <td style={td}>{CHANNEL_LABEL[channel]}</td>
                      <td style={{ ...td, fontFamily: 'monospace', color: '#6c47ff' }}>…{anonId}</td>
                      <td style={td}>{t.turns.length}</td>
                      <td style={{ ...td, maxWidth: 320 }}>{preview}</td>
                      <td style={{ ...td, color: '#a78bff' }}>View →</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && !error && (
        <div style={card}>
          <h2 style={h2}>Bookings from calls</h2>
          <p style={{ fontSize: 13, color: '#888', marginTop: 0, marginBottom: 16 }}>Who's coming in, for what, and how to reach them.</p>
          {visibleBookings.length === 0 ? <p style={{ color: '#888', fontSize: 14 }}>No bookings yet.</p> : (
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>When</th><th style={th}>Service</th><th style={th}>Customer</th>
                  <th style={th}>Vehicle</th><th style={th}>Callback</th><th style={th}>Status</th>
                </tr></thead>
                <tbody>
                  {visibleBookings.map(b => (
                    <tr key={b.id}>
                      <td style={td}>{formatSlot(b.scheduledAt)}</td>
                      <td style={td}>{b.productName}{b.notes ? <div style={{ color: '#888', fontSize: 12 }}>{b.notes}</div> : null}</td>
                      <td style={td}>{b.customerName ?? '—'}</td>
                      <td style={td}>{b.vehicle ?? '—'}</td>
                      <td style={td}>{b.callbackPhone ? <a href={`tel:${b.callbackPhone}`} style={{ color: '#a78bff' }}>{b.callbackPhone}</a> : '—'}</td>
                      <td style={td}>{b.status.toLowerCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!loading && !error && (
        <div style={card}>
          <h2 style={h2}>Messages for staff</h2>
          <p style={{ fontSize: 13, color: '#888', marginTop: 0, marginBottom: 16 }}>Callers who asked to be called back.</p>
          {visibleMessages.length === 0 ? <p style={{ color: '#888', fontSize: 14 }}>No messages.</p> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {visibleMessages.map(m => (
                <div key={m.id} style={{ border: '1px solid #26263a', borderRadius: 10, padding: 12, opacity: m.status === 'DONE' ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 12, color: '#999' }}>
                    <span>{m.callerName ?? 'Caller'} · {m.callbackPhone ? <a href={`tel:${m.callbackPhone}`} style={{ color: '#a78bff' }}>{m.callbackPhone}</a> : 'no number'} · {formatDateTime(m.createdAt)}</span>
                    <button onClick={() => markDone(m)} style={{ background: '#22222f', border: '1px solid #2a2a3a', color: '#ddd', borderRadius: 6, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}>
                      {m.status === 'DONE' ? 'Reopen' : 'Mark done'}
                    </button>
                  </div>
                  <div style={{ fontSize: 14, color: '#eee', marginTop: 6 }}>{m.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: '#000000cc', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
            padding: 'clamp(8px, 4vw, 24px)',
          }}
          onClick={() => setOpenId(null)}
        >
          <div
            style={{
              background: '#15151f', border: '1px solid #26263a', borderRadius: 18,
              maxWidth: 620, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 20px 60px #000000aa', overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: 'clamp(12px, 4vw, 18px) clamp(14px, 4vw, 22px)',
              borderBottom: '1px solid #26263a', background: '#1a1a26',
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg, #6c47ff, #a78bff)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0,
              }}>
                {CHANNEL_LABEL[channelOf(open.callSid)].slice(0, 2)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{sectorName(open.businessType)}</div>
                <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>{formatDateTime(open.createdAt)}</span>
                  {formatDuration(open.createdAt, open.updatedAt) && (
                    <>
                      <span>·</span>
                      <span>{formatDuration(open.createdAt, open.updatedAt)}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{open.turns.length} turns</span>
                </div>
              </div>
              <button
                onClick={() => setOpenId(null)}
                style={{
                  background: '#22222f', border: 'none', color: '#aaa', fontSize: 16, cursor: 'pointer',
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0, lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            {/* Call SID */}
            {open.callSid && (
              <div style={{
                fontSize: 11, color: '#555', fontFamily: 'monospace', padding: 'clamp(6px, 3vw, 8px) clamp(14px, 4vw, 22px) 0',
              }}>
                {open.callSid}
              </div>
            )}

            {open.metrics && open.metrics.length > 0 && (
              <div style={{ padding: 'clamp(10px, 3vw, 14px) clamp(14px, 4vw, 22px)', borderBottom: '1px solid #26263a', maxHeight: '35vh', overflowY: 'auto', flexShrink: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#bbb', marginBottom: 8 }}>Latency per turn</div>
                <LatencyChart metrics={open.metrics} />
              </div>
            )}

            {/* Chat bubbles */}
            <div style={{ padding: 'clamp(12px, 4vw, 18px) clamp(14px, 4vw, 22px)', overflowY: 'auto', display: 'grid', gap: 10 }}>
              {open.turns.map((turn, i) => {
                const isUser = turn.role === 'user';
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                    <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
                      <span style={{ fontSize: 10, color: '#666', marginBottom: 3, padding: '0 4px' }}>
                        {isUser ? 'Customer' : 'Mogi'}
                      </span>
                      <div style={{
                        padding: '10px 14px',
                        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        background: isUser ? 'linear-gradient(135deg, #6c47ff, #5936d9)' : '#22222f',
                        color: isUser ? '#fff' : '#e0e0e0',
                        fontSize: 13.5, lineHeight: 1.5,
                        boxShadow: '0 2px 8px #00000033',
                      }}>
                        {turn.content}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
