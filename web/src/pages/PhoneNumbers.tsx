import { useEffect, useState } from 'react';

// Called number → business (admin API /admin/phone-numbers). A mapped number
// answers as its business on Twilio, Exotel or Plivo; unmapped numbers fall
// back to the "Phone line" default above (Twilio) or the carrier's
// *_DEFAULT_BUSINESS_TYPE (Exotel/Plivo).

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface Row { number: string; provider: string; businessType: string; label: string | null }

const PROVIDERS = [
  { key: 'exotel', name: 'Exotel (India)' },
  { key: 'twilio', name: 'Twilio' },
  { key: 'plivo', name: 'Plivo (India)' },
];

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };
const input: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8 };
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 500, borderBottom: '1px solid #222' };
const td: React.CSSProperties = { padding: '6px 8px', color: '#ddd', borderBottom: '1px solid #1a1a24' };

export default function PhoneNumbers({ base, adminKey, sectors }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [number, setNumber] = useState('');
  const [provider, setProvider] = useState('exotel');
  const [business, setBusiness] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;
  const providerName = (key: string) => PROVIDERS.find(p => p.key === key)?.name ?? key;

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json.data;
  };

  const load = async () => {
    try {
      setRows(await call('/admin/phone-numbers'));
    } catch (e: any) {
      setRows(null);
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => { setMsg(null); if (adminKey) load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminKey, base]);

  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      const saved: Row = await call('/admin/phone-numbers', {
        method: 'PUT',
        body: JSON.stringify({ number, provider, businessType: business, label: label || undefined }),
      });
      setMsg({ text: `${saved.number} (${providerName(saved.provider)}) now answers as ${nameOf(saved.businessType)}.`, ok: true });
      setNumber(''); setLabel('');
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Row) => {
    if (!confirm(`Unmap ${row.number}? Calls to it will fall back to the default business.`)) return;
    setBusy(true); setMsg(null);
    try {
      await call(`/admin/phone-numbers/${row.provider}/${encodeURIComponent(row.number)}`, { method: 'DELETE' });
      setMsg({ text: `${row.number} unmapped.`, ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (!adminKey) return null;

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Phone numbers</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        Which business answers each number. A mapped number overrides the phone-line default; Indian numbers
        (Exotel/Plivo) can be entered as 080…, 98… or +91….
      </p>

      {rows && rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr><th style={th}>Number</th><th style={th}>Carrier</th><th style={th}>Business</th><th style={th}>Label</th><th style={th} /></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.provider}:${r.number}`}>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.number}</td>
                  <td style={td}>{providerName(r.provider)}</td>
                  <td style={td}>{nameOf(r.businessType)}</td>
                  <td style={{ ...td, color: '#999' }}>{r.label ?? ''}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => remove(r)} disabled={busy}
                      style={{ background: 'transparent', color: '#f87171', border: '1px solid #f8717155', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && <p style={{ margin: '0 0 16px', fontSize: 13, color: '#aaa' }}>No numbers mapped yet.</p>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="+91 80 4712 3456" value={number} onChange={e => setNumber(e.target.value)} style={{ ...input, width: 170 }} />
        <select value={provider} onChange={e => setProvider(e.target.value)} style={input}>
          {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <select value={business} onChange={e => setBusiness(e.target.value)} style={{ ...input, minWidth: 180 }}>
          <option value="">Business…</option>
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <input placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} style={{ ...input, width: 150 }} />
        <button onClick={add} disabled={busy || !rows || !number.trim() || !business}
          style={{ background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: busy || !rows || !number.trim() || !business ? 0.5 : 1 }}>
          {busy ? 'Saving…' : 'Map number'}
        </button>
      </div>
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
  );
}
