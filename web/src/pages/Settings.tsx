import { useEffect, useState } from 'react';
import { COUNTRIES, countryDefaults } from '../locale';
import { card as sharedCard } from '../ui';

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface State { selected: string | null; effective: string | null; envDefault: string | null }

const card: React.CSSProperties = sharedCard;

// The operator's default phone line: which business answers unrouted numbers.
export default function DefaultLine({ base, adminKey, sectors }: Props) {
  const [state, setState] = useState<State | null>(null);
  const [choice, setChoice] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const nameOf = (key: string | null) => sectors.find(s => s.key === key)?.name ?? key ?? '—';

  const load = async () => {
    try {
      const res = await fetch(`${base}/admin/default-business`, { headers: { 'X-Admin-Key': adminKey } });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to load');
      setState(json.data);
      setChoice(json.data.effective ?? '');
    } catch (e: any) {
      setState(null);
      setMsg({ text: e.message === 'Admin key required' ? 'Sign in with the admin key to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => { setMsg(null); if (adminKey) load(); else setMsg({ text: 'Sign in with the admin key to manage this.', ok: false }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminKey, base]);

  const save = async (businessType: string | null) => {
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(`${base}/admin/default-business`, {
        method: 'PUT',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessType }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Save failed');
      setMsg({ text: businessType ? `Calls now answered as ${nameOf(businessType)}.` : 'Reverted to the deployed default.', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: 'var(--text-strong)' }}>Default phone line</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 13 }}>
        Which business answers calls to numbers that aren't routed to a business below, and WhatsApp messages to unrouted numbers. Takes effect on the next call.
      </p>
      {state && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
          Currently answering as <b style={{ color: 'var(--text-strong)' }}>{nameOf(state.effective)}</b>
          {state.selected ? '' : ' (deployed default)'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={choice}
          onChange={e => setChoice(e.target.value)}
          disabled={!state}
          style={{ background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-strong)', padding: '8px 12px', borderRadius: 8, minWidth: 220 }}
        >
          {!choice && <option value="">Select a business…</option>}
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <button
          onClick={() => save(choice)}
          disabled={!state || !choice || saving || choice === state.effective}
          style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !state || !choice || saving || choice === state.effective ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state?.selected && (
          <button
            onClick={() => save(null)}
            disabled={saving}
            style={{ background: 'transparent', color: 'var(--accent-text)', border: '1px solid var(--accent-border)', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            Revert to default ({nameOf(state.envDefault)})
          </button>
        )}
      </div>
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </div>
  );
}

// ── Business locale (currency, language/format, country, timezone) ──────────

interface SectorRecord {
  name: string; model: string; categories: string[]; hours: Record<string, string>;
  timezone: string; currency: string; locale?: string; countryCode?: string;
  address?: string; phone?: string; website?: string; about?: string; notifyEmail?: string; capacity?: number;
}

const input: React.CSSProperties = { background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-strong)', padding: '8px 12px', borderRadius: 8, width: '100%', boxSizing: 'border-box' };
const label: React.CSSProperties = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 500, color: 'var(--text)' };

function preview(f: { currency: string; locale: string; timezone: string }): string {
  try {
    const price = new Intl.NumberFormat(f.locale, { style: 'currency', currency: f.currency, maximumFractionDigits: 0 }).format(150000);
    const now = new Intl.DateTimeFormat(f.locale, { timeZone: f.timezone, weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date());
    return `${price} · now ${now}`;
  } catch {
    return 'Not a valid currency / locale / timezone combination';
  }
}

// Works on the operator's admin key or an owner's sign-in (authHeaders()).
export function LocaleSettings({ base, auth, sectors }: { base: string; auth: Record<string, string>; sectors: { key: string; name: string }[] }) {
  const [key, setKey] = useState('');
  const [record, setRecord] = useState<SectorRecord | null>(null);
  const [form, setForm] = useState({ currency: 'USD', locale: 'en-US', countryCode: 'US', timezone: 'America/Chicago' });
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!key && sectors.length) setKey(sectors[0].key); }, [sectors, key]);

  useEffect(() => {
    setRecord(null); setMsg(null);
    if (!key || !Object.keys(auth).length) return;
    fetch(`${base}/admin/sectors/${encodeURIComponent(key)}`, { headers: auth })
      .then(r => r.json())
      .then(json => {
        if (!json.success) throw new Error(json.error ?? 'Failed to load');
        const r: SectorRecord = json.data;
        setRecord(r);
        setForm({ currency: r.currency || 'USD', locale: r.locale || 'en-US', countryCode: r.countryCode || 'US', timezone: r.timezone || 'America/Chicago' });
      })
      .catch((e: Error) => setMsg({ text: e.message, ok: false }));
  }, [base, auth, key]);

  const save = async () => {
    if (!record) return;
    setSaving(true); setMsg(null);
    try {
      // PUT changes only these fields (owners and the operator).
      const res = await fetch(`${base}/admin/sectors/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency: form.currency, locale: form.locale, country_code: form.countryCode, timezone: form.timezone }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Save failed');
      setRecord({ ...record, ...form });
      setMsg({ text: `Saved ${COUNTRIES[form.countryCode]?.name ?? form.countryCode} settings. New calls use them within 5 minutes.`, ok: true });
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: k === 'timezone' ? e.target.value : e.target.value.trim() }));
  const dirty = !!record && (record.currency !== form.currency || (record.locale || 'en-US') !== form.locale
    || (record.countryCode || 'US') !== form.countryCode || record.timezone !== form.timezone);

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: 'var(--text-strong)' }}>Prices, dates and phone numbers</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
        How prices, dates and phone numbers are said and written on calls, WhatsApp, texts, emails and calendar events.
      </p>
      {!Object.keys(auth).length ? <p style={{ fontSize: 13, color: 'var(--danger)', margin: 0 }}>Sign in to manage this.</p> : (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 12 }}>
            {sectors.length > 1 && <label style={label}>Business
              <select value={key} onChange={e => setKey(e.target.value)} style={input}>
                {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </label>}
            <label style={label}>Country
              {/* Picking a country fills in its currency, locale and timezone; each can still be changed below. */}
              <select value={form.countryCode} disabled={!record} style={input}
                onChange={e => setForm(f => countryDefaults(e.target.value, f.timezone))}>
                {!COUNTRIES[form.countryCode] && <option value={form.countryCode}>{form.countryCode}</option>}
                {Object.entries(COUNTRIES).map(([code, c]) => <option key={code} value={code}>{c.flag} {c.name} ({c.dialCode})</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <label style={label}>Currency code<input style={input} value={form.currency} onChange={set('currency')} placeholder="INR" disabled={!record} /></label>
            <label style={label}>Number and date format<input style={input} value={form.locale} onChange={set('locale')} placeholder="en-IN" disabled={!record} /></label>
            <label style={label}>Time zone<input style={input} value={form.timezone} onChange={set('timezone')} placeholder="Asia/Kolkata" disabled={!record} /></label>
          </div>
          {record && COUNTRIES[form.countryCode] && (
            <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
              Callers' local numbers are read with country code {COUNTRIES[form.countryCode].dialCode}.
            </p>
          )}
          {record && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Preview: {preview(form)}</p>}
          <button onClick={save} disabled={!dirty || saving}
            style={{ marginTop: 14, background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !dirty || saving ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </div>
  );
}
