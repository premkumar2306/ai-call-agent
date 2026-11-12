import { useEffect, useState } from 'react';
import { COUNTRIES, countryDefaults } from '../locale';
import { Button, Card, Status } from '../components/ui';

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface State { selected: string | null; effective: string | null; envDefault: string | null }


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
    <Card title="Default phone line" description="Which business answers calls to numbers that aren't routed to a business above, and WhatsApp messages to unrouted numbers. Takes effect on the next call.">
      {state && (
        <p className="muted">Currently answering as <span className="strong">{nameOf(state.effective)}</span>{state.selected ? '' : ' (deployed default)'}</p>
      )}
      <div className="form-row">
        <select className="input input-narrow" aria-label="Business that answers" value={choice} onChange={e => setChoice(e.target.value)} disabled={!state}>
          {!choice && <option value="">Select a business…</option>}
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <Button onClick={() => save(choice)} disabled={!state || !choice || choice === state.effective} busy={saving}>Save</Button>
        {state?.selected && <Button variant="secondary" onClick={() => save(null)} disabled={saving}>Revert to default ({nameOf(state.envDefault)})</Button>}
      </div>
      <Status msg={msg} />
    </Card>
  );
}

// ── Business locale (currency, language/format, country, timezone) ──────────

interface SectorRecord {
  name: string; model: string; categories: string[]; hours: Record<string, string>;
  timezone: string; currency: string; locale?: string; countryCode?: string;
  address?: string; phone?: string; website?: string; about?: string; notifyEmail?: string; capacity?: number;
}


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

  const f = (k: 'currency' | 'locale' | 'timezone', label: string, placeholder: string, help?: string) => (
    <div className="field">
      <label htmlFor={`loc-${k}`}>{label}</label>
      <input id={`loc-${k}`} className="input" value={form[k]} onChange={set(k)} placeholder={placeholder} disabled={!record} />
      {help && <span className="help">{help}</span>}
    </div>
  );

  return (
    <Card title="Prices, dates and phone numbers" description="How prices, dates and phone numbers are said and written on calls, WhatsApp, texts, emails and calendar events. Picking a country fills these in.">
      {!Object.keys(auth).length ? <p className="bad">Sign in to manage this.</p> : (
        <>
          <div className="form-grid">
            {sectors.length > 1 && (
              <div className="field">
                <label htmlFor="loc-biz">Business</label>
                <select id="loc-biz" className="input" value={key} onChange={e => setKey(e.target.value)}>
                  {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="loc-country">Country</label>
              <select id="loc-country" className="input" value={form.countryCode} disabled={!record} onChange={e => setForm(f => countryDefaults(e.target.value, f.timezone))}>
                {!COUNTRIES[form.countryCode] && <option value={form.countryCode}>{form.countryCode}</option>}
                {Object.entries(COUNTRIES).map(([code, c]) => <option key={code} value={code}>{c.flag} {c.name} ({c.dialCode})</option>)}
              </select>
              {record && COUNTRIES[form.countryCode] && <span className="help">Callers' local numbers are read with {COUNTRIES[form.countryCode].dialCode}.</span>}
            </div>
            {f('currency', 'Currency code', 'INR')}
            {f('locale', 'Number and date format', 'en-IN', 'e.g. en-IN, hi-IN')}
            {f('timezone', 'Time zone', 'Asia/Kolkata')}
          </div>
          {record && <p className="muted small">Preview: {preview(form)}</p>}
          <div className="form-actions"><Button onClick={save} disabled={!dirty} busy={saving}>Save</Button></div>
        </>
      )}
      <Status msg={msg} />
    </Card>
  );
}
