import { useEffect, useState } from 'react';
import { api } from '../auth';
import { formatMoney, serviceCategories, toMinorUnits } from '../business';
import { btn, card, ghost, h2, hint, input, msgStyle } from '../ui';

interface Props { sector: string; base: string; auth: Record<string, string>; canEdit: boolean }

interface Product { id: string; name: string; priceCents: number; durationMinutes: number | null; description: string; isActive: boolean; category: string }
interface Draft { name: string; price: string; duration: string; description: string; category: string }

const blank: Draft = { name: '', price: '', duration: '30', description: '', category: '' };
const toDraft = (p: Product): Draft => ({ name: p.name, price: String(p.priceCents / 100), duration: String(p.durationMinutes ?? 60), description: p.description, category: p.category });

// What callers can book. Edits are scoped to this business server-side.
export default function Services({ sector, base, auth, canEdit }: Props) {
  const [rows, setRows] = useState<Product[] | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [cats, setCats] = useState<[string, string][]>([]);
  const [editing, setEditing] = useState<string | null>(null); // product id, or 'new'
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/admin/products/${encodeURIComponent(sector)}`;

  const load = () => Promise.all([
    api<Product[]>(base, path, auth).then(setRows),
    api<{ currency: string; vertical?: string; kind?: string }>(base, `/admin/sectors/${encodeURIComponent(sector)}`, auth).then(s => { setCurrency(s.currency); setCats(serviceCategories(s.vertical, s.kind)); }),
  ]).catch(e => setMsg({ text: e.message, ok: false }));

  useEffect(() => { setRows(null); setEditing(null); setMsg(null); load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sector, base, auth]);

  const save = async () => {
    const priceCents = toMinorUnits(draft.price);
    if (!draft.name.trim()) return setMsg({ text: 'Give the service a name.', ok: false });
    if (priceCents === null) return setMsg({ text: 'Enter a price (0 if free or it varies).', ok: false });
    setBusy(true); setMsg(null);
    try {
      const body = { name: draft.name.trim(), priceCents, durationMinutes: parseInt(draft.duration, 10) || 0, description: draft.description.trim(), ...(draft.category ? { category: draft.category } : {}) };
      if (editing === 'new') await api(base, path, auth, { body });
      else await api(base, `${path}/${encodeURIComponent(editing!)}`, auth, { method: 'PUT', body });
      setEditing(null);
      setMsg({ text: 'Saved.', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (p: Product, isActive: boolean) => {
    setBusy(true); setMsg(null);
    try {
      if (isActive) await api(base, `${path}/${encodeURIComponent(p.id)}`, auth, { method: 'PUT', body: { isActive: true } });
      else await api(base, `${path}/${encodeURIComponent(p.id)}`, auth, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px', gap: 8, padding: '10px 0' }}>
      <input style={input} placeholder="Service name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={120} autoFocus />
      <input style={input} placeholder={`Price (${currency})`} inputMode="decimal" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} />
      <input style={input} placeholder="Minutes" inputMode="numeric" value={draft.duration} onChange={e => setDraft({ ...draft, duration: e.target.value.replace(/\D/g, '') })} />
      <input style={{ ...input, gridColumn: '1 / -1' }} placeholder="Short description (optional) — what's included" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
      {cats.length > 0 && (
        <select style={{ ...input, gridColumn: '1 / -1' }} value={draft.category || 'SERVICES'} onChange={e => setDraft({ ...draft, category: e.target.value })}>
          {!cats.some(([k]) => k === (draft.category || 'SERVICES')) && <option value={draft.category}>{draft.category}</option>}
          {cats.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      )}
      <div style={{ display: 'flex', gap: 8, gridColumn: '1 / -1' }}>
        <button style={btn} disabled={busy} onClick={save}>Save</button>
        <button style={ghost} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
      </div>
    </div>
  );

  const sorted = (rows ?? []).slice().sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
        <div>
          <h2 style={h2}>Services</h2>
          <p style={hint}>What callers can ask about and book, with price and how long it takes.</p>
        </div>
        {canEdit && editing !== 'new' && <button style={btn} onClick={() => { setDraft(blank); setEditing('new'); }}>+ Add service</button>}
      </div>
      {editing === 'new' && editor}
      {!rows && !msg && <p style={hint}>Loading…</p>}
      {rows && !rows.length && <p style={hint}>No services yet.</p>}
      {sorted.map(p => (
        <div key={p.id} style={{ borderTop: '1px solid #1e1e2e', padding: '10px 0', opacity: p.isActive ? 1 : 0.5 }}>
          {editing === p.id ? editor : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#fff', fontSize: 14 }}>{p.name}{!p.isActive && <span style={{ color: '#888' }}> (hidden)</span>}</div>
                {p.description && <div style={{ color: '#888', fontSize: 12 }}>{p.description}</div>}
              </div>
              <div style={{ color: '#ccc', fontSize: 13, whiteSpace: 'nowrap' }}>
                {p.priceCents ? formatMoney(p.priceCents, currency) : 'Free / varies'}{p.durationMinutes ? ` · ${p.durationMinutes} min` : ''}
              </div>
              {canEdit && (
                <>
                  <button style={{ ...ghost, padding: '4px 10px' }} disabled={busy} onClick={() => { setDraft(toDraft(p)); setEditing(p.id); }}>Edit</button>
                  <button style={{ ...ghost, padding: '4px 10px' }} disabled={busy} onClick={() => setActive(p, !p.isActive)}>{p.isActive ? 'Hide' : 'Show'}</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
    </div>
  );
}
