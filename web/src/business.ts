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
  auto_shop: 'Auto repair shop', fitness: 'Gym / fitness studio', vet: 'Veterinary clinic', lawyer: 'Law firm / advocate', other: 'Other',
};

// Mirrors verticalForKind (worker/src/services/verticals.ts): the call script a business type gets.
export function verticalForKind(kind: string | null | undefined): string {
  switch (kind) {
    case 'clinic': case 'dental': return 'clinic';
    case 'lawyer': return 'legal';
    case 'auto_shop': case null: case undefined: case '': return 'general';
    default: return 'appointments';
  }
}

/** What the people callers book with are called, or null when the script books none (auto shop). */
export function practitionerWords(vertical: string | null | undefined, kind: string | null | undefined): { one: string; many: string } | null {
  if (vertical === 'clinic') return kind === 'dental' ? { one: 'Dentist', many: 'Dentists' } : { one: 'Doctor', many: 'Doctors' };
  if (vertical === 'legal') return { one: 'Lawyer', many: 'Lawyers' };
  if (vertical === 'appointments') return { one: 'Team member', many: 'Team members' };
  return null;
}

/** What each script says when the business type changes to it. */
export const SCRIPT_NOTE: Record<string, string> = {
  clinic: 'Avery will talk like a clinic front desk: patient details, doctors\' fees, and medical safety rules (no advice; emergencies to 112).',
  legal: 'Avery will talk like a law firm\'s front office: matter type, the other side\'s name for conflict checks, no legal advice, urgent matters put through.',
  appointments: 'Avery will book appointments without vehicle questions.',
  general: 'Avery will talk like an auto repair shop (asks about the vehicle).',
};

// Service categories with a special meaning in a script: a consultation is
// priced by the doctor's or lawyer's own fee; a lawyer's practice areas.
export const PRACTICE_AREAS: [string, string][] = [
  ['FAMILY', 'Family'], ['PROPERTY', 'Property'], ['CRIMINAL', 'Criminal'], ['CORPORATE', 'Corporate / business'],
  ['CONSUMER', 'Consumer'], ['LABOUR', 'Employment / labour'], ['CIVIL', 'Civil'], ['OTHER_MATTERS', 'Other matters'],
];
export function serviceCategories(vertical: string | null | undefined, kind?: string | null): [string, string][] {
  if (vertical === 'legal') return [['SERVICES', 'General (own price)'], ['CONSULTATION', 'Consultation (lawyer\'s fee)'], ...PRACTICE_AREAS.map(([k, v]) => [k, `${v} consultation (lawyer's fee)`] as [string, string])];
  if (vertical === 'clinic') return [['SERVICES', 'General (own price)'], ['CONSULTATION', `Consultation (${kind === 'dental' ? 'dentist' : 'doctor'}'s fee)`]];
  return [];
}

// Starting points so the services step is mostly "fill in prices".
export const SERVICE_TEMPLATES: Record<string, { name: string; durationMinutes: number; category?: string }[]> = {
  clinic: [{ name: 'General consultation', durationMinutes: 15, category: 'CONSULTATION' }, { name: 'Follow-up visit', durationMinutes: 10 }, { name: 'Health check-up', durationMinutes: 45 }],
  dental: [{ name: 'Consultation', durationMinutes: 20, category: 'CONSULTATION' }, { name: 'Scaling & polishing', durationMinutes: 45 }, { name: 'Filling', durationMinutes: 45 }],
  salon: [{ name: 'Haircut', durationMinutes: 30 }, { name: 'Hair colour', durationMinutes: 90 }, { name: 'Beard trim', durationMinutes: 15 }],
  spa: [{ name: 'Full body massage (60 min)', durationMinutes: 60 }, { name: 'Facial', durationMinutes: 45 }],
  auto_shop: [{ name: 'Oil change', durationMinutes: 45 }, { name: 'General service', durationMinutes: 180 }, { name: 'Brake inspection', durationMinutes: 30 }],
  fitness: [{ name: 'Trial session', durationMinutes: 60 }, { name: 'Personal training session', durationMinutes: 60 }],
  vet: [{ name: 'Consultation', durationMinutes: 20 }, { name: 'Vaccination', durationMinutes: 15 }],
  lawyer: [{ name: 'Consultation', durationMinutes: 30, category: 'CONSULTATION' }, { name: 'Document drafting (rent agreement, affidavit)', durationMinutes: 30 }],
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
