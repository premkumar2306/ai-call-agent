import { useEffect, useState } from 'react';
import { COUNTRIES, countryDefaults } from '../locale';
import PrivacySettings from './PrivacySettings';
import PhoneNumbers from './PhoneNumbers';

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface State { selected: string | null; effective: string | null; envDefault: string | null }

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };

export default function Settings({ base, adminKey, sectors }: Props) {
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
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => { setMsg(null); if (adminKey) load(); else setMsg({ text: 'Enter the admin key (top right) to manage this.', ok: false }); },
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
    <div style={{ display: 'grid', gap: 16 }}>
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Phone line</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        Which business answers inbound Twilio calls on numbers not mapped below (and WhatsApp messages without a number-specific mapping). Takes effect on the next call.
      </p>
      {state && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#aaa' }}>
          Currently answering as <b style={{ color: '#fff' }}>{nameOf(state.effective)}</b>
          {state.selected ? '' : ' (deployed default)'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={choice}
          onChange={e => setChoice(e.target.value)}
          disabled={!state}
          style={{ background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, minWidth: 220 }}
        >
          {!choice && <option value="">Select a business…</option>}
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <button
          onClick={() => save(choice)}
          disabled={!state || !choice || saving || choice === state.effective}
          style={{ background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !state || !choice || saving || choice === state.effective ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state?.selected && (
          <button
            onClick={() => save(null)}
            disabled={saving}
            style={{ background: 'transparent', color: '#a78bff', border: '1px solid #6c47ff66', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            Revert to default ({nameOf(state.envDefault)})
          </button>
        )}
      </div>
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
    <PrivacySettings base={base} adminKey={adminKey} sectors={sectors} />
    <PhoneNumbers base={base} adminKey={adminKey} sectors={sectors} />
    </div>
  );
}

// ── Business locale (currency, language/format, country, timezone) ──────────

interface SectorRecord {
  name: string; model: string; categories: string[]; hours: Record<string, string>;
  timezone: string; currency: string; locale?: string; countryCode?: string;
  address?: string; phone?: string; website?: string; about?: string; notifyEmail?: string; capacity?: number;
}

const input: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, width: '100%', boxSizing: 'border-box' };
const label: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: '#999' };

function preview(f: { currency: string; locale: string; timezone: string }): string {
  try {
    const price = new Intl.NumberFormat(f.locale, { style: 'currency', currency: f.currency, maximumFractionDigits: 0 }).format(150000);
    const now = new Intl.DateTimeFormat(f.locale, { timeZone: f.timezone, weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date());
    return `${price} · now ${now}`;
  } catch {
    return 'Not a valid currency / locale / timezone combination';
  }
}

export function LocaleSettings({ base, adminKey, sectors }: Props) {
  const [key, setKey] = useState('');
  const [record, setRecord] = useState<SectorRecord | null>(null);
  const [form, setForm] = useState({ currency: 'USD', locale: 'en-US', countryCode: 'US', timezone: 'America/Chicago' });
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!key && sectors.length) setKey(sectors[0].key); }, [sectors, key]);

  useEffect(() => {
    setRecord(null); setMsg(null);
    if (!key || !adminKey) return;
    fetch(`${base}/admin/sectors/${encodeURIComponent(key)}`, { headers: { 'X-Admin-Key': adminKey } })
      .then(r => r.json())
      .then(json => {
        if (!json.success) throw new Error(json.error ?? 'Failed to load');
        const r: SectorRecord = json.data;
        setRecord(r);
        setForm({ currency: r.currency || 'USD', locale: r.locale || 'en-US', countryCode: r.countryCode || 'US', timezone: r.timezone || 'America/Chicago' });
      })
      .catch((e: Error) => setMsg({ text: e.message, ok: false }));
  }, [base, adminKey, key]);

  const save = async () => {
    if (!record) return;
    setSaving(true); setMsg(null);
    try {
      // POST /admin/sectors replaces the whole record, so send the rest back unchanged.
      const res = await fetch(`${base}/admin/sectors`, {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key, name: record.name, model: record.model, categories: record.categories, hours: record.hours,
          address: record.address, phone: record.phone, website: record.website, about: record.about,
          notify_email: record.notifyEmail, capacity: record.capacity,
          currency: form.currency, locale: form.locale, country_code: form.countryCode, timezone: form.timezone,
        }),
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
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Business locale</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        How this business's prices, dates and phone numbers are spoken and written — on calls, WhatsApp, texts, emails and calendar events.
        Prices in the catalog are in the currency's smallest unit (cents, paise).
      </p>
      {!adminKey ? <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Enter the admin key (top right) to manage this.</p> : (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 12 }}>
            <label style={label}>Business
              <select value={key} onChange={e => setKey(e.target.value)} style={input}>
                {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </label>
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
            <label style={label}>Currency (ISO 4217)<input style={input} value={form.currency} onChange={set('currency')} placeholder="INR" disabled={!record} /></label>
            <label style={label}>Locale (BCP 47)<input style={input} value={form.locale} onChange={set('locale')} placeholder="en-IN" disabled={!record} /></label>
            <label style={label}>Timezone (IANA)<input style={input} value={form.timezone} onChange={set('timezone')} placeholder="Asia/Kolkata" disabled={!record} /></label>
          </div>
          {record && COUNTRIES[form.countryCode] && (
            <p style={{ margin: '12px 0 0', fontSize: 13, color: '#aaa' }}>
              Callers' local numbers are read with country code {COUNTRIES[form.countryCode].dialCode}.
            </p>
          )}
          {record && <p style={{ margin: '12px 0 0', fontSize: 13, color: '#aaa' }}>Preview: {preview(form)}</p>}
          <button onClick={save} disabled={!dirty || saving}
            style={{ marginTop: 14, background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !dirty || saving ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
  );
}
