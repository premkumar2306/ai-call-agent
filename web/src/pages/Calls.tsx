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
  createdAt: number | string;
  updatedAt?: number | string;
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
