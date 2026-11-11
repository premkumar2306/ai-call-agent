import { useEffect, useState } from 'react';
import { api } from '../auth';
import { DAYS, PRACTICE_AREAS, formatMoney, practitionerWords, toMinorUnits } from '../business';
import { btn, card, ghost, h2, hint, input, label, msgStyle } from '../ui';

// The people callers book with — a clinic's doctors, a dental practice's
// dentists, a law firm's lawyers, a salon's team — each with their own
// hours, appointment length, fee and the kinds of service they do
// (/admin/resources/:business, owner-scoped).

interface Props { sector: string; base: string; auth: Record<string, string>; canEdit: boolean }

interface Person {
  id: string; name: string; role: string | null; hours: Record<string, string>; slotMinutes: number;
  feeCents: number | null; about: string | null; categories: string[] | null; isActive: boolean;
}
interface Draft { name: string; role: string; hours: Record<string, string>; slot: string; fee: string; about: string; categories: string[] }

const blank: Draft = { name: '', role: '', hours: { mon: '10am–1pm, 5pm–8pm', tue: '10am–1pm, 5pm–8pm', wed: '10am–1pm, 5pm–8pm', thu: '10am–1pm, 5pm–8pm', fri: '10am–1pm, 5pm–8pm', sat: '10am–1pm' }, slot: '15', fee: '', about: '', categories: [] };
const toDraft = (p: Person): Draft => ({
  name: p.name, role: p.role ?? '', hours: { ...p.hours }, slot: String(p.slotMinutes),
  fee: p.feeCents == null ? '' : String(p.feeCents / 100), about: p.about ?? '', categories: p.categories ?? [],
});
const pretty = (c: string) => PRACTICE_AREAS.find(([k]) => k === c)?.[1] ?? c.replace(/_/g, ' ').toLowerCase().replace(/^\w/, x => x.toUpperCase());

export default function Practitioners({ sector, base, auth, canEdit }: Props) {
  const [rows, setRows] = useState<Person[] | null>(null);
  const [biz, setBiz] = useState<{ vertical?: string; kind?: string; currency: string } | null>(null);
  const [serviceCats, setServiceCats] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // id, or 'new'
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/admin/resources/${encodeURIComponent(sector)}`;

  const load = () => Promise.all([
    api<Person[]>(base, path, auth).then(setRows),
    api<any>(base, `/admin/sectors/${encodeURIComponent(sector)}`, auth).then(s => setBiz({ vertical: s.vertical, kind: s.kind, currency: s.currency })),
    api<{ category: string; isActive: boolean }[]>(base, `/admin/products/${encodeURIComponent(sector)}`, auth)
      .then(ps => setServiceCats([...new Set(ps.filter(p => p.isActive).map(p => p.category))])),
  ]).catch(e => setMsg({ text: e.message, ok: false }));

  useEffect(() => { setRows(null); setEditing(null); setMsg(null); load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sector, base, auth]);

  const words = biz ? practitionerWords(biz.vertical, biz.kind) : null;
  if (biz && !words) {
    return (
      <div style={card}>
        <h2 style={h2}>Team</h2>
        <p style={{ ...hint, margin: 0 }}>This business type books by time slot, not with a named person. Change the business type in the Business tab to book doctors, lawyers or team members.</p>
      </div>
    );
  }
  const one = words?.one ?? 'Person', many = words?.many ?? 'People';
  // Categories: what this business's services use, plus practice areas for a law firm.
  const catOptions = [...new Set([...(biz?.vertical === 'legal' ? PRACTICE_AREAS.map(([k]) => k) : []), ...serviceCats])];

  const save = async () => {
    if (draft.name.trim().length < 2) return setMsg({ text: 'Enter a name.', ok: false });
    const fee = draft.fee.trim() ? toMinorUnits(draft.fee) : null;
    if (draft.fee.trim() && fee === null) return setMsg({ text: 'Enter the fee as a number (or leave it empty).', ok: false });
    setBusy(true); setMsg(null);
    try {
      const hours = Object.fromEntries(Object.entries(draft.hours).filter(([, v]) => v.trim()));
      const body = {
        name: draft.name.trim(), role: draft.role.trim(), hours, slotMinutes: parseInt(draft.slot, 10) || 0,
        feeCents: fee, about: draft.about.trim(), categories: draft.categories,
      };
      if (editing === 'new') await api(base, path, auth, { body });
      else await api(base, `${path}/${encodeURIComponent(editing!)}`, auth, { method: 'PUT', body });
      setEditing(null);
      setMsg({ text: 'Saved. Avery uses it from the next call (within 5 minutes).', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (p: Person, isActive: boolean) => {
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

  const toggleCat = (c: string) => setDraft(d => ({ ...d, categories: d.categories.includes(c) ? d.categories.filter(x => x !== c) : [...d.categories, c] }));

  const editor = (
    <div style={{ display: 'grid', gap: 10, padding: '10px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <label style={label}>Name<input style={input} value={draft.name} maxLength={120} autoFocus placeholder={biz?.vertical === 'legal' ? 'Adv. Meera Kulkarni' : biz?.vertical === 'clinic' ? 'Dr. Ananya Rao' : 'Name'}
          onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label style={label}>Role / speciality<input style={input} value={draft.role} maxLength={120} placeholder={biz?.vertical === 'legal' ? 'Partner — family law' : 'General physician'}
          onChange={e => setDraft({ ...draft, role: e.target.value })} /></label>
        <label style={label}>Appointment length (minutes)<input style={input} inputMode="numeric" value={draft.slot}
          onChange={e => setDraft({ ...draft, slot: e.target.value.replace(/\D/g, '') })} /></label>
        <label style={label}>{biz?.vertical === 'appointments' ? 'Fee' : 'Consultation fee'} ({biz?.currency}, optional)<input style={input} inputMode="decimal" value={draft.fee}
          onChange={e => setDraft({ ...draft, fee: e.target.value })} /></label>
      </div>
      <div style={label}>Hours (leave a day empty when they're not in; split sessions like "10am–1pm, 5pm–9pm")
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          {DAYS.map(([d, name]) => (
            <label key={d} style={{ ...label, fontSize: 13 }}>{name}
              <input style={input} value={draft.hours[d] ?? ''} placeholder="closed"
                onChange={e => setDraft({ ...draft, hours: { ...draft.hours, [d]: e.target.value } })} />
            </label>
          ))}
        </div>
      </div>
      {catOptions.length > 0 && (
        <div style={label}>{biz?.vertical === 'legal' ? 'Practice areas' : 'Services they do'} (none ticked = everything)
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {catOptions.map(c => (
              <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)', fontSize: 13 }}>
                <input type="checkbox" checked={draft.categories.includes(c)} onChange={() => toggleCat(c)} />{pretty(c)}
              </label>
            ))}
          </div>
        </div>
      )}
      <label style={label}>Languages spoken, anything callers should know (optional)<input style={input} value={draft.about} maxLength={1000}
        onChange={e => setDraft({ ...draft, about: e.target.value })} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn} disabled={busy} onClick={save}>Save</button>
        <button style={ghost} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
      </div>
    </div>
  );

  const sorted = (rows ?? []).slice().sort((a, b) => Number(b.isActive) - Number(a.isActive));

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
        <div>
          <h2 style={h2}>{many}</h2>
          <p style={hint}>Callers can book with a particular {one.toLowerCase()}, or Avery offers whoever is free first. Each has their own hours{biz?.vertical === 'appointments' ? '' : ' and fee'}.</p>
        </div>
        {canEdit && editing !== 'new' && <button style={btn} onClick={() => { setDraft(blank); setEditing('new'); }}>+ Add {one.toLowerCase()}</button>}
      </div>
      {editing === 'new' && editor}
      {!rows && !msg && <p style={hint}>Loading…</p>}
      {rows && !rows.length && editing !== 'new' && <p style={hint}>No {many.toLowerCase()} yet. Without any, Avery books by the business's opening hours.</p>}
      {sorted.map(p => (
        <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0', opacity: p.isActive ? 1 : 0.5 }}>
          {editing === p.id ? editor : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--text-strong)', fontSize: 14 }}>{p.name}{p.role ? <span style={{ color: 'var(--text-muted)' }}> — {p.role}</span> : null}{!p.isActive && <span style={{ color: 'var(--text-muted)' }}> (inactive)</span>}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {DAYS.filter(([d]) => p.hours[d]).map(([d]) => `${d} ${p.hours[d]}`).join(' · ')}
                  {p.categories?.length ? ` · ${p.categories.map(pretty).join(', ')}` : ''}
                </div>
              </div>
              <div style={{ color: 'var(--text)', fontSize: 13, whiteSpace: 'nowrap' }}>
                {p.feeCents != null && biz ? `${formatMoney(p.feeCents, biz.currency)} · ` : ''}{p.slotMinutes} min
              </div>
              {canEdit && (
                <>
                  <button style={{ ...ghost, padding: '4px 10px' }} disabled={busy} onClick={() => { setDraft(toDraft(p)); setEditing(p.id); }}>Edit</button>
                  <button style={{ ...ghost, padding: '4px 10px' }} disabled={busy} onClick={() => setActive(p, !p.isActive)}>{p.isActive ? 'Deactivate' : 'Activate'}</button>
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
