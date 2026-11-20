// Onboarding presets: the settings a new business starts with, in one place.
// Used by scripts/onboard-clinic.mjs (operator onboarding from a lead). Plain
// data only (no imports), so Node can load this file directly. Everything uses
// the fields the existing admin APIs already accept; nothing here switches on a
// message to a patient (WhatsApp stays OFF until the owner's templates are approved).

export interface PresetService { name: string; durationMinutes: number; category: string }

export interface ClinicPreset {
  id: string;
  kind: string;                       // BUSINESS_KINDS key (accounts.ts)
  countryCode: string; currency: string; timezone: string; locale: string;
  /** POST /admin/sectors/:key/voice fields. hi-en = English with Hindi/Hinglish. */
  voice: { voice_language: string; stt_provider: string; tts_provider: string };
  /** A placeholder until the owner confirms real hours. Same as the sign-up wizard's default. */
  hours: Record<string, string>;
  /** Starter list (same as the Services page "dental" starter). Price 0 = price on request. */
  services: PresetService[];
  durationBooking: boolean; guardrails: boolean; dtmfInput: boolean;
  /** Cached fillers instead of dead air while a tool runs (0033). */
  naturalFillers: boolean;
  plan: string; offer: string;        // attached; nothing is charged until the owner subscribes
  pilot: { mode: 'overflow'; days: number };  // dates are set at activation (pilotWindow)
  /** Front-desk confirmation: needs the front desk's phone, so it is applied only when one is given. */
  confirmationMode: boolean;
  whatsapp: { reminders: boolean; missedCallFollowup: boolean; recalls: boolean; reviewRequests: boolean; noShowRecovery: boolean };
  /** DPDP notice: on; wording null = built-in text in the line's language. */
  dpdp: { aiDisclosure: boolean; disclosureText: null };
}

export const INDIA_DENTAL: ClinicPreset = {
  id: 'india-dental',
  kind: 'dental',
  countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', locale: 'en-IN',
  voice: { voice_language: 'hi-en', stt_provider: 'sarvam', tts_provider: 'sarvam' },
  hours: { mon: '9am–6pm', tue: '9am–6pm', wed: '9am–6pm', thu: '9am–6pm', fri: '9am–6pm', sat: '10am–2pm' },
  services: [
    { name: 'Consultation', durationMinutes: 15, category: 'CONSULTATION' },
    { name: 'Cleaning / scaling', durationMinutes: 30, category: 'SERVICES' },
    { name: 'Filling', durationMinutes: 45, category: 'SERVICES' },
    { name: 'Root canal', durationMinutes: 60, category: 'SERVICES' },
    { name: 'Extraction', durationMinutes: 30, category: 'SERVICES' },
    { name: 'Crown fitting', durationMinutes: 60, category: 'SERVICES' },
    { name: 'Teeth whitening', durationMinutes: 60, category: 'SERVICES' },
    { name: 'Braces consultation', durationMinutes: 30, category: 'SERVICES' },
  ],
  durationBooking: true, guardrails: true, dtmfInput: true, naturalFillers: true,
  plan: 'in_clinic', offer: 'FOUNDING25',
  pilot: { mode: 'overflow', days: 14 },
  confirmationMode: true,
  whatsapp: { reminders: false, missedCallFollowup: false, recalls: false, reviewRequests: false, noShowRecovery: false },
  dpdp: { aiDisclosure: true, disclosureText: null },
};

export const PRESETS: Record<string, ClinicPreset> = { [INDIA_DENTAL.id]: INDIA_DENTAL };

/** Business key from a lead slug: lowercase, underscores (matches the keys sign-up makes). */
export function businessKey(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

/** Stable product id, so re-running never duplicates a service. */
export function serviceId(key: string, name: string): string {
  return `${key}-svc-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Pilot dates at activation: starts today (business-local date given), ends `days` later, inclusive of the start. */
export function pilotWindow(startsOn: string, days: number): { startsOn: string; endsOn: string } {
  const d = new Date(`${startsOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return { startsOn, endsOn: d.toISOString().slice(0, 10) };
}
