import { useEffect, useState } from 'react';
import { api } from '../auth';
import { btn, card, h2, hint, input, msgStyle } from '../ui';

// Operator-only Settings cards: WhatsApp number routing and owners' requests
// for a phone number.

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border)' };
const td: React.CSSProperties = { padding: '6px 8px', color: 'var(--text)', borderBottom: '1px solid var(--border)' };
const danger: React.CSSProperties = { background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger-border)', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' };

interface WaRow { phoneNumberId: string; businessType: string; label: string | null }

// WhatsApp Business phone_number_id → business (/admin/whatsapp-numbers).
export function WhatsAppNumbers({ base, adminKey, sectors }: Props) {
  const auth = { 'X-Admin-Key': adminKey };
  const [rows, setRows] = useState<WaRow[] | null>(null);
  const [id, setId] = useState('');
  const [business, setBusiness] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;

  const load = () => api<WaRow[]>(base, '/admin/whatsapp-numbers', auth).then(setRows).catch(e => setMsg({ text: e.message, ok: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setMsg(null); if (adminKey) load(); }, [adminKey, base]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ text: ok, ok: true }); await load(); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  if (!adminKey) return null;
  return (
    <div style={card}>
      <h2 style={h2}>WhatsApp numbers</h2>
      <p style={hint}>
        Which business answers each WhatsApp Business number (the <b>phone number ID</b> from Meta's WhatsApp Manager). No redeploy needed.
        Numbers not listed here fall back to <code>WA_PHONE_NUMBER_MAP</code>, then the phone-line default.
      </p>
      {rows && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
          <thead><tr><th style={th}>Phone number ID</th><th style={th}>Business</th><th style={th}>Label</th><th style={th} /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.phoneNumberId}>
                <td style={{ ...td, fontFamily: 'monospace' }}>{r.phoneNumberId}</td>
                <td style={td}>{nameOf(r.businessType)}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{r.label ?? ''}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button style={danger} disabled={busy} onClick={() => confirm(`Unmap ${r.phoneNumberId}?`) &&
                    run(() => api(base, `/admin/whatsapp-numbers/${r.phoneNumberId}`, auth, { method: 'DELETE' }), `${r.phoneNumberId} unmapped.`)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length === 0 && <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-muted)' }}>No WhatsApp numbers mapped yet.</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Phone number ID, e.g. 1234567890" value={id} onChange={e => setId(e.target.value.trim())} style={{ ...input, width: 240 }} />
        <select value={business} onChange={e => setBusiness(e.target.value)} style={{ ...input, width: 200 }}>
          <option value="">Business…</option>
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <input placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} style={{ ...input, width: 150 }} />
        <button style={{ ...btn, opacity: busy || !id || !business ? 0.5 : 1 }} disabled={busy || !id || !business}
          onClick={() => run(() => api(base, '/admin/whatsapp-numbers', auth, { method: 'PUT', body: { phoneNumberId: id, businessType: business, label: label || undefined } })
            .then(() => { setId(''); setLabel(''); }), `WhatsApp number now answers as ${nameOf(business)}.`)}>
          Map number
        </button>
      </div>
      {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
    </div>
  );
}

interface RequestRow { id: string; businessType: string; requestedBy: string | null; note: string | null; status: string; createdAt: string | number }

// Owners' "Request a phone number" (/admin/number-requests).
export function NumberRequests({ base, adminKey, sectors }: Props) {
  const auth = { 'X-Admin-Key': adminKey };
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;
  const load = () => api<RequestRow[]>(base, '/admin/number-requests', auth).then(setRows).catch(e => setMsg({ text: e.message, ok: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (adminKey) load(); }, [adminKey, base]);
  const setStatus = (r: RequestRow, status: 'open' | 'done') =>
    api(base, `/admin/number-requests/${r.id}`, auth, { method: 'PATCH', body: { status } }).then(load).catch(e => setMsg({ text: e.message, ok: false }));

  if (!adminKey) return null;
  const open = rows?.filter(r => r.status === 'open') ?? [];
  return (
    <div style={card}>
      <h2 style={h2}>Phone number requests {open.length ? <span style={{ color: 'var(--warning)' }}>({open.length} open)</span> : null}</h2>
      <p style={hint}>Owners ask for a number at the end of sign-up. Connect a number below, then mark the request done.</p>
      {rows && !rows.length && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>No requests yet.</p>}
      {rows && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr><th style={th}>Business</th><th style={th}>Requested by</th><th style={th}>Note</th><th style={th}>When</th><th style={th} /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ opacity: r.status === 'done' ? 0.5 : 1 }}>
                <td style={td}>{nameOf(r.businessType)}</td>
                <td style={td}>{r.requestedBy ?? ''}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{r.note ?? ''}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{new Date(typeof r.createdAt === 'number' ? r.createdAt * 1000 : r.createdAt).toLocaleDateString()}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button style={{ ...danger, color: 'var(--accent-text)', borderColor: 'var(--accent-border)' }} onClick={() => setStatus(r, r.status === 'open' ? 'done' : 'open')}>
                    {r.status === 'open' ? 'Mark done' : 'Reopen'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
    </div>
  );
}
