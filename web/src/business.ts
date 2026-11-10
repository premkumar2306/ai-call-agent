// Helpers shared by the onboarding wizard and the Business / Services tabs.

export const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
] as const;
export type DayKey = typeof DAYS[number][0];

export interface DayHours { open: boolean; from: string; to: string } // "09:00" (24h, <input type=time>)
export type WeekHours = Record<DayKey, DayHours>;

export const BUSINESS_KINDS: Record<string, string> = {
  clinic: 'Clinic / doctor', dental: 'Dental clinic', salon: 'Salon / barber', spa: 'Spa / wellness',
  auto_shop: 'Auto repair shop', fitness: 'Gym / fitness studio', vet: 'Veterinary clinic', other: 'Other',
};

// Starting points so the services step is mostly "fill in prices".
export const SERVICE_TEMPLATES: Record<string, { name: string; durationMinutes: number }[]> = {
  clinic: [{ name: 'General consultation', durationMinutes: 15 }, { name: 'Follow-up visit', durationMinutes: 10 }, { name: 'Health check-up', durationMinutes: 45 }],
  dental: [{ name: 'Consultation', durationMinutes: 20 }, { name: 'Scaling & polishing', durationMinutes: 45 }, { name: 'Filling', durationMinutes: 45 }],
  salon: [{ name: 'Haircut', durationMinutes: 30 }, { name: 'Hair colour', durationMinutes: 90 }, { name: 'Beard trim', durationMinutes: 15 }],
  spa: [{ name: 'Full body massage (60 min)', durationMinutes: 60 }, { name: 'Facial', durationMinutes: 45 }],
  auto_shop: [{ name: 'Oil change', durationMinutes: 45 }, { name: 'General service', durationMinutes: 180 }, { name: 'Brake inspection', durationMinutes: 30 }],
  fitness: [{ name: 'Trial session', durationMinutes: 60 }, { name: 'Personal training session', durationMinutes: 60 }],
  vet: [{ name: 'Consultation', durationMinutes: 20 }, { name: 'Vaccination', durationMinutes: 15 }],
  other: [{ name: 'Appointment', durationMinutes: 30 }],
};

export const DEFAULT_HOURS: WeekHours = {
  mon: { open: true, from: '09:00', to: '18:00' }, tue: { open: true, from: '09:00', to: '18:00' },
  wed: { open: true, from: '09:00', to: '18:00' }, thu: { open: true, from: '09:00', to: '18:00' },
  fri: { open: true, from: '09:00', to: '18:00' }, sat: { open: true, from: '10:00', to: '14:00' },
  sun: { open: false, from: '10:00', to: '14:00' },
};

/** "09:30" → "9:30am", "18:00" → "6pm" (the format the Worker stores and speaks). */
export function to12h(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${ap}`;
}

/** "7:30am" → "07:30" */
export function to24h(t: string): string | null {
  const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
}

export function hoursToApi(week: WeekHours): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [d] of DAYS) if (week[d].open) out[d] = `${to12h(week[d].from)}–${to12h(week[d].to)}`;
  return out;
}

export function hoursFromApi(hours: Record<string, string> | undefined): WeekHours {
  const week = structuredClone(DEFAULT_HOURS);
  for (const [d] of DAYS) {
    const range = hours?.[d];
    const [a, b] = range ? range.split(/\s*[–-]\s*/) : [];
    const from = a ? to24h(a) : null, to = b ? to24h(b) : null;
    week[d] = from && to ? { open: true, from, to } : { ...week[d], open: false };
  }
  return week;
}

export function hoursProblem(week: WeekHours): string | null {
  const open = DAYS.filter(([d]) => week[d].open);
  if (!open.length) return 'Open at least one day a week.';
  for (const [d, name] of open) if (!(week[d].from < week[d].to)) return `${name}: closing time must be after opening time.`;
  return null;
}

export const COMMON_TIMEZONES = [
  'Asia/Kolkata', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney',
];

export const CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD'];

export function guessTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; }
}

export function currencyFor(tz: string): string {
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
  if (tz.startsWith('America/')) return 'USD';
  if (tz === 'Europe/London') return 'GBP';
  if (tz === 'Asia/Dubai') return 'AED';
  if (tz === 'Asia/Singapore') return 'SGD';
  if (tz.startsWith('Australia/')) return 'AUD';
  if (tz.startsWith('Europe/')) return 'EUR';
  return 'USD';
}

/** "1,500.50" → 150050; null when not a price. */
export function toMinorUnits(s: string): number | null {
  const clean = s.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
  } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}
