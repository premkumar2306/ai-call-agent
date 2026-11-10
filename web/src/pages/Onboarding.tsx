import { useState } from 'react';
import { api } from '../auth';
import {
  BUSINESS_KINDS, COMMON_TIMEZONES, CURRENCIES, DEFAULT_HOURS, SERVICE_TEMPLATES,
  currencyFor, guessTimezone, hoursProblem, hoursToApi, toMinorUnits, type WeekHours,
} from '../business';
import HoursEditor from '../components/HoursEditor';
import { btn, card, ghost, h2, hint, input, label, msgStyle } from '../ui';

interface Props {
  base: string;
  auth: Record<string, string>;
  /** Called with the new business key once it exists. */
  onCreated: (key: string) => void;
  onCancel?: () => void;
}

interface ServiceRow { name: string; price: string; duration: string }

const STEPS = ['Your business', 'Opening hours', 'Services', 'Review'] as const;

// Four short steps → POST /account/businesses. Everything here can be changed
// later in the Business and Services tabs, so the defaults are generous.
export default function Onboarding({ base, auth, onCreated, onCancel }: Props) {
  const tz0 = guessTimezone();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [timezone, setTimezone] = useState(tz0);
  const [currency, setCurrency] = useState(currencyFor(tz0));
  const [hours, setHours] = useState<WeekHours>(DEFAULT_HOURS);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pickKind = (k: string) => {
    setKind(k);
    // Prefill services from the template unless the owner already typed some.
    if (!services.some(s => s.name || s.price)) {
      setServices((SERVICE_TEMPLATES[k] ?? SERVICE_TEMPLATES.other).map(t => ({ name: t.name, price: '', duration: String(t.durationMinutes) })));
    }
  };

  const cleanServices = () => services.filter(s => s.name.trim() || s.price.trim());

  const problem = (): string | null => {
    if (step === 0) {
      if (name.trim().length < 2) return 'Enter your business name.';
      if (!kind) return 'Choose what kind of business it is.';
      if (phone.trim() && !/^\+[1-9]\d{7,14}$/.test(phone.replace(/[\s\-().]/g, ''))) return 'Staff phone needs the country code, e.g. +91 98765 43210.';
    }
    if (step === 1) return hoursProblem(hours);
    if (step === 2) {
      const rows = cleanServices();
      if (!rows.length) return 'Add at least one service.';
      for (const s of rows) {
        if (!s.name.trim()) return 'Every service needs a name.';
        if (toMinorUnits(s.price) === null) return `Enter a price for “${s.name}” (0 if free or it varies).`;
        const d = Number(s.duration);
        if (!Number.isInteger(d) || d < 5 || d > 600) return `Duration for “${s.name}” must be 5–600 minutes.`;
      }
    }
    return null;
  };

  const next = () => {
    const p = problem();
    if (p) { setError(p); return; }
    setError('');
    setStep(s => s + 1);
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      const data = await api<{ key: string }>(base, '/account/businesses', auth, {
        body: {
          name: name.trim(), kind, address: address.trim(), phone: phone.trim(), timezone, currency,
          hours: hoursToApi(hours),
          services: cleanServices().map(s => ({ name: s.name.trim(), priceCents: toMinorUnits(s.price), durationMinutes: Number(s.duration) })),
        },
      });
      onCreated(data.key);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const setService = (i: number, patch: Partial<ServiceRow>) => setServices(rows => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const tzOptions = COMMON_TIMEZONES.includes(timezone) ? COMMON_TIMEZONES : [timezone, ...COMMON_TIMEZONES];

  return (
    <div style={{ ...card, padding: 28, display: 'grid', gap: 20 }}>
      <div>
        <h2 style={h2}>Set up your AI receptionist</h2>
        <p style={{ ...hint, margin: 0 }}>About 5 minutes. You can change everything later.</p>
      </div>
      <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => (
          <li key={s} style={{
            fontSize: 12, padding: '4px 10px', borderRadius: 99,
            background: i === step ? '#6c47ff' : i < step ? '#6c47ff33' : '#1e1e2e', color: i <= step ? '#fff' : '#777',
          }}>{i + 1}. {s}</li>
        ))}
      </ol>

      {step === 0 && (
        <div style={{ display: 'grid', gap: 14 }}>
          <label style={label}>Business name
            <input style={input} value={name} onChange={e => setName(e.target.value)} placeholder="Sharma Dental Care" autoFocus maxLength={80} />
          </label>
          <div style={label}>What kind of business?
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.entries(BUSINESS_KINDS).map(([k, v]) => (
                <button key={k} type="button" onClick={() => pickKind(k)}
                  style={{ ...ghost, padding: '6px 12px', fontSize: 13, ...(kind === k ? { background: '#6c47ff', color: '#fff', borderColor: '#6c47ff' } : {}) }}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          <label style={label}><span>Address <span style={{ color: '#666' }}>— callers ask where you are</span></span>
            <input style={input} value={address} onChange={e => setAddress(e.target.value)} placeholder="12 MG Road, Bengaluru 560001" maxLength={300} />
          </label>
          <label style={label}><span>Staff phone for transfers <span style={{ color: '#666' }}>— optional; Avery puts callers through to it during opening hours</span></span>
            <input style={input} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={label}>Time zone
              <select style={input} value={timezone} onChange={e => { setTimezone(e.target.value); setCurrency(currencyFor(e.target.value)); }}>
                {tzOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label style={label}>Currency
              <select style={input} value={currency} onChange={e => setCurrency(e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'grid', gap: 10 }}>
          <p style={{ ...hint, margin: 0 }}>Avery only books inside these hours and tells callers when you're open.</p>
          <HoursEditor value={hours} onChange={setHours} />
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: 10 }}>
          <p style={{ ...hint, margin: 0 }}>What can callers book? Price in {currency}; use 0 if it's free or varies. Duration is how long to block in the diary.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px 32px', gap: 8, fontSize: 12, color: '#777' }}>
            <span>Service</span><span>Price ({currency})</span><span>Minutes</span><span />
          </div>
          {services.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px 32px', gap: 8 }}>
              <input style={input} value={s.name} onChange={e => setService(i, { name: e.target.value })} placeholder="Service name" maxLength={120} aria-label="Service name" />
              <input style={input} inputMode="decimal" value={s.price} onChange={e => setService(i, { price: e.target.value })} placeholder="500" aria-label="Price" />
              <input style={input} inputMode="numeric" value={s.duration} onChange={e => setService(i, { duration: e.target.value.replace(/\D/g, '') })} placeholder="30" aria-label="Minutes" />
              <button type="button" onClick={() => setServices(rows => rows.filter((_, j) => j !== i))} aria-label="Remove service"
                style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 18 }}>×</button>
            </div>
          ))}
          <button type="button" style={{ ...ghost, justifySelf: 'start' }}
            onClick={() => setServices(rows => [...rows, { name: '', price: '', duration: '30' }])}>+ Add a service</button>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'grid', gap: 8, fontSize: 14, color: '#ccc' }}>
          <div><b style={{ color: '#fff' }}>{name}</b> · {BUSINESS_KINDS[kind]}</div>
          {address && <div>{address}</div>}
          <div>{timezone} · {currency}{phone ? ` · transfers to ${phone}` : ''}</div>
          <div>Open: {Object.entries(hoursToApi(hours)).map(([d, h]) => `${d[0].toUpperCase()}${d.slice(1)} ${h}`).join(', ')}</div>
          <div>{cleanServices().length} service{cleanServices().length === 1 ? '' : 's'}: {cleanServices().map(s => s.name).join(', ')}</div>
          <p style={{ ...hint, margin: '8px 0 0' }}>Booking and message notifications go to your sign-in email; change that in the Business tab.</p>
        </div>
      )}

      {error && <p style={msgStyle(false)}>{error}</p>}

      <div style={{ display: 'flex', gap: 10 }}>
        {step > 0 && <button type="button" style={ghost} disabled={busy} onClick={() => { setError(''); setStep(s => s - 1); }}>Back</button>}
        {step === 0 && onCancel && <button type="button" style={ghost} onClick={onCancel}>Cancel</button>}
        {step < STEPS.length - 1
          ? <button type="button" style={btn} onClick={next}>Continue</button>
          : <button type="button" style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create my receptionist'}</button>}
      </div>
    </div>
  );
}
