import { useEffect, useState } from 'react';
import { api } from '../auth';
import { BUSINESS_KINDS, COMMON_TIMEZONES, CURRENCIES, SCRIPT_NOTE, hoursFromApi, hoursProblem, hoursToApi, verticalForKind, type WeekHours } from '../business';
import { COUNTRIES, countryDefaults } from '../locale';
import HoursEditor from '../components/HoursEditor';
import { btn, card, h2, hint, input, label, msgStyle } from '../ui';

interface Props { sector: string; base: string; auth: Record<string, string>; canEdit: boolean; onRenamed?: () => void }

interface Form {
  name: string; kind: string; address: string; phone: string; website: string; timezone: string;
  currency: string; about: string; notifyEmail: string; capacity: string; countryCode: string;
}

// The owner's view of what Avery knows about the business (PUT /admin/sectors/:key).
export default function Business({ sector, base, auth, canEdit, onRenamed }: Props) {
  const [form, setForm] = useState<Form | null>(null);
  const [hours, setHours] = useState<WeekHours | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [savedKind, setSavedKind] = useState('');
  const [savedCountry, setSavedCountry] = useState('');

  useEffect(() => {
    setForm(null); setMsg(null);
    api<any>(base, `/admin/sectors/${encodeURIComponent(sector)}`, auth)
      .then(d => {
        setForm({
          name: d.name ?? '', kind: d.kind ?? '', address: d.address ?? '', phone: d.phone ?? '', website: d.website ?? '',
          timezone: d.timezone ?? '', currency: d.currency ?? '', about: d.about ?? '', notifyEmail: d.notifyEmail ?? '',
          capacity: String(d.capacity ?? 1), countryCode: d.countryCode ?? 'US',
        });
        setSavedKind(d.kind ?? '');
        setSavedCountry(d.countryCode ?? 'US');
        setHours(hoursFromApi(d.hours));
      })
      .catch(e => setMsg({ text: e.message, ok: false }));
  }, [sector, base, auth]);

  const save = async () => {
    if (!form || !hours) return;
    const p = hoursProblem(hours);
    if (p) { setMsg({ text: p, ok: false }); return; }
    const kindChanged = !!form.kind && form.kind !== savedKind;
    if (kindChanged && !confirm(`Change the business type to ${BUSINESS_KINDS[form.kind]}?\n\n${SCRIPT_NOTE[verticalForKind(form.kind)]}\n\nThis changes what Avery asks callers from the next call.`)) return;
    setSaving(true); setMsg(null);
    try {
      await api(base, `/admin/sectors/${encodeURIComponent(sector)}`, auth, {
        method: 'PUT',
        body: {
          name: form.name, ...(kindChanged ? { kind: form.kind } : {}), ...(form.countryCode !== savedCountry ? { country_code: form.countryCode } : {}), address: form.address, phone: form.phone,
          website: form.website, timezone: form.timezone, currency: form.currency, about: form.about,
          notifyEmail: form.notifyEmail, capacity: parseInt(form.capacity, 10) || 1, hours: hoursToApi(hours),
        },
      });
      setMsg({ text: 'Saved. Avery uses the new details from the next call.', ok: true });
      setSavedKind(form.kind);
      setSavedCountry(form.countryCode);
      onRenamed?.();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  if (!form || !hours) return <div style={card}>{msg ? <p style={msgStyle(false)}>{msg.text}</p> : 'Loading…'}</div>;
  const f = (k: keyof Form) => ({ value: form[k], disabled: !canEdit, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }) });
  const tzs = COMMON_TIMEZONES.includes(form.timezone) ? COMMON_TIMEZONES : [form.timezone, ...COMMON_TIMEZONES];
  const curs = CURRENCIES.includes(form.currency) ? CURRENCIES : [form.currency, ...CURRENCIES];

  return (
    <div style={{ ...card, display: 'grid', gap: 14 }}>
      <div>
        <h2 style={h2}>Business details</h2>
        <p style={{ ...hint, margin: 0 }}>Everything Avery tells callers about you comes from here and the Services tab.{canEdit ? '' : ' Only owners can change it.'}</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={label}>Name<input style={input} maxLength={80} {...f('name')} /></label>
        <label style={label}>Type
          <select style={input} {...f('kind')}>
            {!form.kind && <option value="">—</option>}
            {Object.entries(BUSINESS_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {form.kind && form.kind !== savedKind && <p style={{ ...hint, margin: 0, color: '#fbbf24' }}>Changing the type changes Avery's call script: {SCRIPT_NOTE[verticalForKind(form.kind)]}</p>}
      <label style={label}>Address<input style={input} maxLength={300} {...f('address')} /></label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={label}>Staff phone for transfers<input style={input} type="tel" placeholder="+91 98765 43210" {...f('phone')} /></label>
        <label style={label}>Website<input style={input} maxLength={200} {...f('website')} /></label>
        <label style={label}>Country
          <select style={input} value={form.countryCode} disabled={!canEdit}
            onChange={e => { const d = countryDefaults(e.target.value, form.timezone); setForm({ ...form, countryCode: d.countryCode, currency: d.currency, timezone: d.timezone }); }}>
            {!COUNTRIES[form.countryCode] && <option value={form.countryCode}>{form.countryCode}</option>}
            {Object.entries(COUNTRIES).map(([code, c]) => <option key={code} value={code}>{c.flag} {c.name} ({c.dialCode})</option>)}
          </select>
        </label>
        <label style={label}>Time zone<select style={input} {...f('timezone')}>{tzs.map(t => <option key={t}>{t}</option>)}</select></label>
        <label style={label}>Currency<select style={input} {...f('currency')}>{curs.map(c => <option key={c}>{c}</option>)}</select></label>
        <label style={label}>Booking &amp; message emails go to<input style={input} type="email" {...f('notifyEmail')} /></label>
        <label style={label}>Appointments at the same time<input style={input} inputMode="numeric" {...f('capacity')} /></label>
      </div>
      <label style={label}>Anything else callers ask about (parking, payment, languages…)
        <textarea style={{ ...input, minHeight: 80, resize: 'vertical' }} maxLength={4000} {...f('about')} />
      </label>
      <div style={label}>Opening hours
        {canEdit ? <HoursEditor value={hours} onChange={setHours} /> : <span style={{ color: '#ccc' }}>{Object.entries(hoursToApi(hours)).map(([d, h]) => `${d} ${h}`).join(', ')}</span>}
      </div>
      {canEdit && <button style={{ ...btn, justifySelf: 'start', opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
      {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
    </div>
  );
}
