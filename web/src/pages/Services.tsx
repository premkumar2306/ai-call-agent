import { useEffect, useState } from 'react';
import { api } from '../auth';
import { STARTER_SERVICES, formatMoney, serviceCategories, starterKey, toMinorUnits } from '../business';
import { parseServiceLines } from '../servicesImport';
import { btn, card, ghost, h2, hint, input, msgStyle } from '../ui';

interface Props { sector: string; base: string; auth: Record<string, string>; canEdit: boolean }

interface Product { id: string; name: string; priceCents: number; durationMinutes: number | null; description: string; isActive: boolean; category: string }
interface Draft { name: string; price: string; duration: string; description: string; category: string; onRequest: boolean }

// No new column: "on request" is price 0 plus this marker in the description, which the assistant reads as "not free".
const ON_REQUEST = 'Price on request';

const blank: Draft = { name: '', price: '', duration: '30', description: '', category: '', onRequest: false };
const toDraft = (p: Product): Draft => ({ name: p.name, price: String(p.priceCents / 100), duration: String(p.durationMinutes ?? 60), description: p.description === ON_REQUEST ? '' : p.description, category: p.category, onRequest: p.priceCents === 0 });

// What callers can book. Edits are scoped to this business server-side.
export default function Services({ sector, base, auth, canEdit }: Props) {
  const [rows, setRows] = useState<Product[] | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [cats, setCats] = useState<[string, string][]>([]);
  const [editing, setEditing] = useState<string | null>(null); // product id, or 'new'
  const [draft, setDraft] = useState<Draft>(blank);
  const [starter, setStarter] = useState<ReturnType<typeof starterKey>>('general');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/admin/products/${encodeURIComponent(sector)}`;

  const load = () => Promise.all([
    api<Product[]>(base, path, auth).then(setRows),
    api<{ currency: string; vertical?: string; kind?: string }>(base, `/admin/sectors/${encodeURIComponent(sector)}`, auth).then(s => { setCurrency(s.currency); setCats(serviceCategories(s.vertical, s.kind)); setStarter(starterKey(s.vertical, s.kind)); }),
  ]).catch(e => setMsg({ text: e.message, ok: false }));

  useEffect(() => { setRows(null); setEditing(null); setMsg(null); load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sector, base, auth]);

  const save = async () => {
    const priceCents = draft.onRequest ? 0 : toMinorUnits(draft.price);
    if (!draft.name.trim()) return setMsg({ text: 'Give the service a name.', ok: false });
    if (priceCents === null) return setMsg({ text: 'Enter a price, or tick "Price varies / on request".', ok: false });
    const description = priceCents === 0 && draft.onRequest && !draft.description.trim() ? ON_REQUEST : draft.description.trim();
    setBusy(true); setMsg(null);
    try {
      const body = { name: draft.name.trim(), priceCents, durationMinutes: parseInt(draft.duration, 10) || 0, description, ...(draft.category ? { category: draft.category } : {}) };
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

  const addMany = async (items: { name: string; priceCents: number; durationMinutes: number; category?: string }[]) => {
    setBusy(true); setMsg(null);
    try {
      for (const it of items) await api(base, path, auth, { body: { ...it, description: it.priceCents === 0 ? ON_REQUEST : '' } });
      setPasteText('');
      setMsg({ text: `Added ${items.length} service${items.length === 1 ? '' : 's'}. Edit any of them below.`, ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const parsed = parseServiceLines(pasteText);
  const list = STARTER_SERVICES[starter];

  const editor = (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px', gap: 8, padding: '10px 0' }}>
      <input style={input} placeholder="Service name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={120} autoFocus />
      <input style={input} placeholder={draft.onRequest ? 'On request' : `Price (${currency})`} disabled={draft.onRequest} inputMode="decimal" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} />
      <input style={input} placeholder="Minutes" inputMode="numeric" value={draft.duration} onChange={e => setDraft({ ...draft, duration: e.target.value.replace(/\D/g, '') })} />
      <label style={{ ...hint, gridColumn: '1 / -1', display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
        <input type="checkbox" checked={draft.onRequest} onChange={e => setDraft({ ...draft, onRequest: e.target.checked, price: e.target.checked ? '' : draft.price })} /> Price varies / on request
      </label>
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
          <h2 style={h2}>Services & prices</h2>
          <p style={hint}>What callers can ask about and book, with price and how long it takes.</p>
        </div>
        {canEdit && editing !== 'new' && <button style={btn} onClick={() => { setDraft(blank); setEditing('new'); }}>+ Add service</button>}
      </div>
      {editing === 'new' && editor}
      {!rows && !msg && <p style={hint}>Loading…</p>}
      {rows && !rows.length && <p style={hint}>No services yet.</p>}
      {rows && !rows.length && canEdit && (
        <div style={{ margin: '8px 0' }}>
          <button style={btn} disabled={busy} onClick={() => addMany(list.items.map(i => ({ ...i, priceCents: 0 })))}>Start with a typical {list.label} list</button>
          <p style={hint}>{list.items.length} editable services with typical durations. Prices are left as "price on request" for you to fill in.</p>
        </div>
      )}
      {canEdit && rows && (
        <details style={{ margin: '8px 0' }}>
          <summary style={{ ...hint, cursor: 'pointer' }}>Paste a list</summary>
          <textarea style={{ ...input, width: '100%', minHeight: 90, boxSizing: 'border-box' }} value={pasteText} onChange={e => setPasteText(e.target.value)}
            placeholder={'One per line: name, price, minutes\nCleaning - 800 - 30\nRoot canal, 4500, 60min'} aria-label="Paste services" />
          {parsed.good.length > 0 && (
            <table style={{ width: '100%', fontSize: 13, color: 'var(--text)', borderCollapse: 'collapse' }}>
              <tbody>{parsed.good.map((g, i) => (
                <tr key={i}><td>{g.name}</td><td>{g.priceCents ? formatMoney(g.priceCents, currency) : 'On request'}</td><td>{g.durationMinutes} min</td></tr>
              ))}</tbody>
            </table>
          )}
          {parsed.bad.length > 0 && <p style={msgStyle(false)}>Skipped: {parsed.bad.map(b => `"${b.line}" (${b.reason})`).join('; ')}</p>}
          {parsed.good.length > 0 && <button style={{ ...btn, marginTop: 8 }} disabled={busy} onClick={() => addMany(parsed.good)}>Add all ({parsed.good.length})</button>}
        </details>
      )}
      {sorted.map(p => (
        <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0', opacity: p.isActive ? 1 : 0.5 }}>
          {editing === p.id ? editor : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--text-strong)', fontSize: 14 }}>{p.name}{!p.isActive && <span style={{ color: 'var(--text-muted)' }}> (hidden)</span>}</div>
                {p.description && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{p.description}</div>}
              </div>
              <div style={{ color: 'var(--text)', fontSize: 13, whiteSpace: 'nowrap' }}>
                {p.priceCents ? formatMoney(p.priceCents, currency) : 'On request'}{p.durationMinutes ? ` · ${p.durationMinutes} min` : ''}
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
