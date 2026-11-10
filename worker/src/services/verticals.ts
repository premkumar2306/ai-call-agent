import type { Order, SectorMeta } from '../types';

// ── Verticals ───────────────────────────────────────────────────────────────
// What changes between kinds of business — the details a booking needs, how
// the front desk talks about prices and staff, extra safety rules — lives
// here as data, picked by `sectors.vertical`. Code reads the active vertical
// instead of testing business types, so adding one (salon, vet…) is a new
// entry, not edits across the booking flow.
//
// `general` is what every business without a vertical gets. Its text is
// exactly what the platform said before verticals existed (pinned by
// test/us-unchanged.test.ts), so the US auto shop is unaffected.

/** One extra thing the front desk writes down with a booking. */
export interface BookingField {
  /** Tool argument name, and key in orders.details. */
  key: string;
  /** For staff: emails, calendar events, admin UI. */
  label: string;
  /** JSON schema the model sees on book_appointment. */
  schema: { type: 'string'; description: string; enum?: string[] };
  /** Description on update_booking, when it differs. */
  updateDescription?: string;
  /** Stored in this legacy orders column instead of orders.details. */
  column?: 'vehicle';
}

/** People (or chairs, rooms) a booking is made with, each with their own hours. */
export interface ResourceSpec {
  /** Tool argument naming one, e.g. `doctor_id`. */
  param: string;
  /** "doctor" — used in tool descriptions and spoken replies. */
  noun: string;
  /** Profile section heading. */
  heading: string;
  /** Products in these categories cost the resource's own fee (a consultation). */
  feeCategories: string[];
  /** How a fee-priced product reads in the profile and replies. */
  feeText: string;
  /** Profile label for the fee. */
  feeLabel: string;
}

export interface Vertical {
  key: string;
  /** "our shop" / "our clinic". */
  place: string;
  /** Who picks up on a transfer: "the service desk". */
  desk: string;
  /** Spoken for a $0 price that is really "it depends". */
  quotePrice: string;
  bookingFields: BookingField[];
  /** Each group needs at least one filled field before booking (e.g. age OR new/returning). */
  requiredAnyOf: string[][];
  /** Spoken when a required group is missing. */
  askMissing: string;
  /** Spoken when the name is missing. */
  askName: string;
  customerNameDescription: string;
  notesDescription: string;
  updateNotesDescription: string;
  resources?: ResourceSpec;
  /** Prompt lines; see buildAgentRules (turn.service.ts). */
  prompt: {
    priceRule: string;
    unknownRule: string;
    booking1: string;
    booking2: string;
    booking3: string;
    corrections: string;
    afterBooking: string;
    transfer: string;
    cantAnswer: string;
    /** Whole extra sections appended to the rules (safety). */
    extra?: string;
  };
}

const GENERAL: Vertical = {
  key: 'general',
  place: 'shop',
  desk: 'the service desk',
  quotePrice: 'price depends on the vehicle',
  bookingFields: [{
    key: 'vehicle',
    label: 'Vehicle',
    column: 'vehicle',
    schema: { type: 'string', description: 'Year, make and model, for businesses that work on vehicles (e.g. "2018 Honda Civic").' },
    updateDescription: 'Year, make and model.',
  }],
  requiredAnyOf: [],
  askMissing: 'Can I get a few details for the booking?',
  askName: 'Can I get your name for the booking?',
  customerNameDescription: "The caller's name, as they said it.",
  notesDescription: 'Anything the staff should know (symptoms, requests).',
  updateNotesDescription: 'Symptoms or requests for the technician.',
  prompt: {
    priceRule: `- Price questions when the profile has no price ("price depends on the vehicle"): answer like a service writer, never "we don't publish prices". Two short sentences, like: "It depends on the vehicle — what are you driving? We've got an oil change special on right now, too." Once you know the vehicle, offer to book it in (the advisor confirms the exact price before any work starts) or have an advisor call back with the exact price.`,
    unknownRule: `- If the profile doesn't cover something, say you can't confirm that from here and offer to take a message so a service advisor calls them back (or connect them, if they'd rather talk now). Never invent facts, prices or policies.`,
    booking1: `1. Work out which service they need from the profile. Map symptoms to services yourself (squeaking brakes → brakes, warning light → diagnostics). If the cause is unknown (a noise, a feeling), book the inspection or diagnostic service — not a repair — and put their symptoms in notes.`,
    booking2: `2. When they want to come in, call check_availability with the service's [id], plus preferred_date (YYYY-MM-DD from the dates below), time_of_day and preferred_time if they mentioned them. Offer the times it returns. If it says requested_open, book that requested_slot in the same turn — they already chose it.`,
    booking3: `3. Once they've picked a time (not before — don't ask for details while they're still asking questions), get their name — and, if the business works on vehicles, the year, make and model — in one short question, if you don't already have them from this call. Their callback number is the one they're calling from; only ask for a number if book_appointment says it needs one.`,
    corrections: `- Corrections after booking (name misheard, different number, other vehicle, symptoms): update_booking on that booking — not a message.`,
    afterBooking: `5. After booking, you may mention the profile's "pairs well with" add-on once, then ask if there's anything else.`,
    transfer: `- Wants a person, or needs something only staff can do: transfer_to_staff. If the shop is closed or there's no answer, take_message instead.`,
    cantAnswer: `- Questions you can't answer from the profile (exact quotes, coupons, special requests): offer to take_message so a service advisor calls them back, instead of telling them to call.`,
  },
};

// Clinics and dental practices. Bookings are with a doctor (a resource with
// its own OPD hours, slot length and consultation fee) and record who the
// patient is and why they're coming. The receptionist never gives medical
// advice, and sends emergencies to 112 / the nearest emergency department.
const CLINIC: Vertical = {
  key: 'clinic',
  place: 'clinic',
  desk: 'the front desk',
  quotePrice: 'the doctor confirms the cost at the visit',
  bookingFields: [
    {
      key: 'patient_status',
      label: 'New or returning',
      schema: { type: 'string', enum: ['new', 'returning'], description: 'Whether the patient has visited this clinic before.' },
    },
    {
      key: 'patient_age',
      label: 'Age',
      schema: { type: 'string', description: 'The patient\'s age in years, as said (e.g. "34", "6 months").' },
    },
    {
      key: 'reason_for_visit',
      label: 'Reason for visit',
      schema: { type: 'string', description: 'A few words in the caller\'s own terms (e.g. "fever for three days", "tooth pain", "routine check-up"). Never a diagnosis.' },
    },
  ],
  requiredAnyOf: [['patient_status', 'patient_age']],
  askMissing: 'Has the patient visited us before, or is this their first visit?',
  askName: "Can I get the patient's name for the appointment?",
  customerNameDescription: "The patient's name (the person seeing the doctor), as the caller said it.",
  notesDescription: 'Anything the front desk should know (e.g. needs wheelchair access, bringing old reports). Never a diagnosis.',
  updateNotesDescription: 'Anything the front desk should know. Never a diagnosis.',
  resources: {
    param: 'doctor_id',
    noun: 'doctor',
    heading: 'Doctors (book with the doctor\'s [doctor_id])',
    feeCategories: ['CONSULTATION', 'CHILD_CONSULTATION', 'DENTAL_CONSULTATION'],
    feeText: 'fee depends on the doctor',
    feeLabel: 'consultation fee',
  },
  prompt: {
    priceRule: `- Fee questions: a consultation costs that doctor's consultation fee (listed under Doctors); other services list their own price. Say the amount plainly. If something has no fixed price, say the doctor confirms the cost at the visit.`,
    unknownRule: `- If the profile doesn't cover something, say you can't confirm that from here and offer to take a message so the front desk calls them back (or connect them, if they'd rather talk now). Never invent facts, prices or policies.`,
    booking1: `1. Work out what the visit is for and which doctor. If they ask for a doctor by name, use that doctor. Otherwise pick the service that fits what they said (a consultation when unsure) and leave the doctor open so the earliest free doctor is offered — or the doctor whose specialty plainly matches (teeth → the dentist). Never suggest what the problem might be.`,
    booking2: `2. When they want to come in, call check_availability with the service's [id], the doctor_id if they want a particular doctor, plus preferred_date (YYYY-MM-DD from the dates below), time_of_day and preferred_time if they mentioned them. Offer the times it returns (each says which doctor). If it says requested_open, book that requested_slot in the same turn — they already chose it.`,
    booking3: `3. Once they've picked a time (not before — don't ask for details while they're still asking questions), get the patient's name, whether they've visited the clinic before (or their age), and the reason for the visit — in one short question, skipping anything you already have from this call. The patient may not be the caller (a parent booking for a child). Their callback number is the one they're calling from; only ask for a number if book_appointment says it needs one.`,
    corrections: `- Corrections after booking (name misheard, different number, age, reason for the visit): update_booking on that booking — not a message.`,
    afterBooking: `5. After booking, ask if there's anything else. Don't suggest extra services.`,
    transfer: `- Wants a person, or needs something only staff can do (reports, refunds, a doctor calling them back): transfer_to_staff. If the clinic is closed or there's no answer, take_message instead.`,
    cantAnswer: `- Questions you can't answer from the profile (insurance, test results, special requests): offer to take_message so the front desk calls them back, instead of telling them to call.`,
    extra: `MEDICAL SAFETY (this overrides everything above):
- You are a receptionist, not a doctor. Never give medical advice or a diagnosis: no opinion on what a symptom might be or whether it's serious, no medicine names or doses, no "it's probably nothing", no home remedies. If asked, say kindly that the doctor will advise at the visit, and offer the earliest appointment.
- Emergencies — chest pain or pressure, trouble breathing, heavy bleeding, fainting or not waking up, signs of a stroke (face drooping, arm weakness, slurred speech), a fit or seizure, a severe allergic reaction, poisoning or overdose, a serious accident or injury, severe pain or bleeding in pregnancy, or someone talking about harming themselves: stop booking. First tell them to call 112 now or go to the nearest emergency department. Then offer to connect them to the clinic staff (transfer_to_staff). Never offer a routine appointment instead. If you're unsure whether it's an emergency, treat it as one.
- Ask only for a short reason for the visit — don't question them about symptoms or medical history.`,
  },
};

export const VERTICALS: Record<string, Vertical> = { general: GENERAL, clinic: CLINIC };

export function getVertical(meta: Pick<SectorMeta, 'vertical'> | null | undefined): Vertical {
  return (meta?.vertical && VERTICALS[meta.vertical]) || GENERAL;
}

export function isVertical(key: unknown): key is string {
  return typeof key === 'string' && key in VERTICALS;
}

/** The vertical's fields that live in orders.details (not legacy columns), from tool args. */
export function detailsFromArgs(v: Vertical, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of v.bookingFields) {
    if (f.column) continue;
    const raw = args[f.key];
    const val = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!val) continue;
    if (f.schema.enum && !f.schema.enum.includes(val.toLowerCase())) continue;
    out[f.key] = (f.schema.enum ? val.toLowerCase() : val).slice(0, 200);
  }
  return out;
}

/** The first required group with nothing filled in, if any. */
export function missingRequired(v: Vertical, filled: Record<string, unknown>): string[] | null {
  for (const group of v.requiredAnyOf) {
    if (!group.some(k => typeof filled[k] === 'string' ? (filled[k] as string).trim() : filled[k] != null)) return group;
  }
  return null;
}

const LABELS = new Map(Object.values(VERTICALS).flatMap(v => v.bookingFields.map(f => [f.key, f.label] as const)));

/**
 * Lines for staff (email, calendar, admin) describing what was taken down
 * beyond name and number. The vehicle line keeps its pre-vertical wording.
 */
export function bookingDetailLines(order: Pick<Order, 'vehicle' | 'resourceName' | 'details'>): string[] {
  const lines: string[] = [];
  if (order.resourceName) lines.push(`With: ${order.resourceName}`);
  if (order.vehicle) lines.push(`Vehicle: ${order.vehicle}`);
  for (const [k, v] of Object.entries(order.details ?? {})) {
    if (v) lines.push(`${LABELS.get(k) ?? k.replace(/_/g, ' ')}: ${v}`);
  }
  return lines;
}
