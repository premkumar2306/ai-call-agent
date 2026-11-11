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

// Salons, spas, gyms, vets and any other appointment business: the general
// booking flow without the auto-shop wording (no vehicle, no "what are you
// driving?"). Team members can be bookable resources with their own hours.
const APPOINTMENTS: Vertical = {
  key: 'appointments',
  place: 'business',
  desk: 'the team',
  quotePrice: 'the exact price is confirmed at the visit',
  bookingFields: [],
  requiredAnyOf: [],
  askMissing: 'Can I get a few details for the booking?',
  askName: 'Can I get your name for the booking?',
  customerNameDescription: "The caller's name, as they said it.",
  notesDescription: 'Anything the team should know (requests, preferences).',
  updateNotesDescription: 'Requests or preferences for the team.',
  resources: {
    param: 'staff_id',
    noun: 'team member',
    heading: "Team (book with the team member's [staff_id])",
    feeCategories: [],
    feeText: 'price depends on the team member',
    feeLabel: 'fee',
  },
  prompt: {
    priceRule: `- Price questions: say the service's listed price plainly. If something has no fixed price, say the exact price is confirmed at the visit, and offer to book it or take a message so someone calls them back with the price.`,
    unknownRule: `- If the profile doesn't cover something, say you can't confirm that from here and offer to take a message so someone from the team calls them back (or connect them, if they'd rather talk now). Never invent facts, prices or policies.`,
    booking1: `1. Work out which service they need from the profile. If they ask for a team member by name, book with that person; otherwise leave it open so the earliest free person is offered. If you're unsure which service fits, pick the closest one and put what they said in notes.`,
    booking2: `2. When they want to come in, call check_availability with the service's [id], the staff_id if they want a particular person, plus preferred_date (YYYY-MM-DD from the dates below), time_of_day and preferred_time if they mentioned them. Offer the times it returns. If it says requested_open, book that requested_slot in the same turn — they already chose it.`,
    booking3: `3. Once they've picked a time (not before — don't ask for details while they're still asking questions), get their name in one short question, if you don't already have it from this call. Their callback number is the one they're calling from; only ask for a number if book_appointment says it needs one.`,
    corrections: `- Corrections after booking (name misheard, different number, requests): update_booking on that booking — not a message.`,
    afterBooking: `5. After booking, you may mention the profile's "pairs well with" add-on once, then ask if there's anything else.`,
    transfer: `- Wants a person, or needs something only staff can do: transfer_to_staff. If the business is closed or there's no answer, take_message instead.`,
    cantAnswer: `- Questions you can't answer from the profile (exact quotes, special requests): offer to take_message so someone from the team calls them back, instead of telling them to call.`,
  },
};

// Practice areas a law firm's lawyers (resources) can be booked for. A
// consultation in any of them costs that lawyer's consultation fee.
export const PRACTICE_AREAS = ['FAMILY', 'PROPERTY', 'CRIMINAL', 'CORPORATE', 'CONSUMER', 'LABOUR', 'CIVIL', 'OTHER_MATTERS'] as const;
const MATTER_TYPES = ['family', 'property', 'criminal', 'corporate', 'consumer', 'labour', 'other'];

// Law firms and advocates. Bookings are a consultation with a lawyer (a
// resource with their own hours, fee and practice areas). The receptionist
// never gives legal advice or promotes the firm (Bar Council of India rules
// bar advocates from advertising or soliciting), keeps case details to one
// line, and puts urgent matters (arrest, a court date within 48 hours,
// domestic violence) straight through to the firm.
const LEGAL: Vertical = {
  key: 'legal',
  place: 'firm',
  desk: 'the office',
  quotePrice: 'the lawyer confirms any fees beyond the consultation',
  bookingFields: [
    {
      key: 'client_status',
      label: 'New or existing client',
      schema: { type: 'string', enum: ['new', 'existing'], description: 'Whether the caller is already a client of this firm.' },
    },
    {
      key: 'matter_type',
      label: 'Matter type',
      schema: { type: 'string', enum: MATTER_TYPES, description: 'The kind of legal matter, from what the caller said.' },
    },
    {
      key: 'matter_summary',
      label: 'Short description',
      schema: { type: 'string', description: 'One line in the caller\'s own words (e.g. "dispute with landlord over deposit"). Never more detail than that, and never an opinion on it.' },
    },
    {
      key: 'opposing_party',
      label: 'Opposing party (for conflict check)',
      schema: { type: 'string', description: 'Name of the other side (person or company), if the caller knows it — the firm checks it for conflicts of interest.' },
    },
    {
      key: 'urgency',
      label: 'Urgency',
      schema: { type: 'string', enum: ['routine', 'urgent'], description: 'urgent for an arrest or police custody, a court date within 48 hours, or domestic violence; otherwise routine.' },
    },
  ],
  requiredAnyOf: [['matter_type']],
  askMissing: 'What kind of matter is it — for example family, property, consumer or something else?',
  askName: 'Can I get your name for the consultation?',
  customerNameDescription: "The client's name, as the caller said it.",
  notesDescription: 'Practical notes for the office only (e.g. prefers a call in the evening, needs an interpreter). Never case details or an opinion.',
  updateNotesDescription: 'Practical notes for the office. Never case details or an opinion.',
  resources: {
    param: 'lawyer_id',
    noun: 'lawyer',
    heading: 'Lawyers (book with the lawyer\'s [lawyer_id])',
    feeCategories: ['CONSULTATION', ...PRACTICE_AREAS],
    feeText: 'fee depends on the lawyer',
    feeLabel: 'consultation fee',
  },
  prompt: {
    priceRule: `- Fee questions: a consultation costs that lawyer's consultation fee (listed under Lawyers); other services list their own price. Say the amount plainly. Never quote or estimate any other fee (case fees, retainers, court costs) — say the lawyer discusses fees at the consultation.`,
    unknownRule: `- If the profile doesn't cover something, say you can't confirm that from here and offer to take a message so the office calls them back (or connect them, if they'd rather talk now). Never invent facts, fees or policies.`,
    booking1: `1. Work out which lawyer and which consultation. If they ask for a lawyer by name, use that lawyer. Otherwise pick the consultation for their kind of matter and leave the lawyer open so the earliest free lawyer who handles it is offered.`,
    booking2: `2. When they want a consultation, call check_availability with the service's [id], the lawyer_id if they want a particular lawyer, plus preferred_date (YYYY-MM-DD from the dates below), time_of_day and preferred_time if they mentioned them. Offer the times it returns (each says which lawyer). If it says requested_open, book that requested_slot in the same turn — they already chose it.`,
    booking3: `3. Once they've picked a time (not before — don't ask for details while they're still asking questions), get the client's name, the kind of matter, a one-line description, and whether they are a new or existing client — in one or two short questions, skipping anything you already have. Ask for the other side's name too ("so the firm can check for conflicts") — if they don't know or won't say, that's fine. Their callback number is the one they're calling from; only ask for a number if book_appointment says it needs one.`,
    corrections: `- Corrections after booking (name misheard, different number, kind of matter, other side's name): update_booking on that booking — not a message.`,
    afterBooking: `5. After booking, ask if there's anything else. Don't suggest extra services.`,
    transfer: `- Wants a person, or needs something only the office can do (documents, case updates, a lawyer calling them back): transfer_to_staff. If the office is closed or there's no answer, take_message instead.`,
    cantAnswer: `- Questions you can't answer from the profile (case status, documents, special requests): offer to take_message so the office calls them back, instead of telling them to call.`,
    extra: `LEGAL SAFETY (this overrides everything above):
- You are a receptionist, not a lawyer. Never give legal advice: no opinion on whether they have a case, its merits or chances, what the law says, what they should do, or how it will turn out. Never promise or suggest a result. If asked, say kindly that the lawyer will advise them at the consultation.
- Confidentiality: ask only for a one-line description of the matter. Don't ask for or note details of the case; if they start explaining, say gently that the lawyer will discuss it with them in confidence.
- Fees: only the consultation fees listed here. Never quote, estimate or compare any other fee.
- No promotion: never sell or praise the firm, compare it with others, or claim it is the best, most successful or most experienced. Advocates in India may not advertise or solicit work (Bar Council of India rules), so answer factual questions only (hours, address, who handles which kind of matter, consultation fees).
- Urgent matters — someone arrested or in police custody, a court hearing or deadline within 48 hours, or domestic violence: don't book a routine consultation. Offer to connect them to the office right now (transfer_to_staff); if it's closed or no one answers, take an urgent message (take_message, saying it is urgent). If anyone is in danger right now, first tell them to call 112.`,
  },
};

// Dental practices use the clinic vertical with dentist wording. Tool
// argument names (doctor_id) stay the same.
function withDentistWording(v: Vertical): Vertical {
  const keep = '\u0000';
  const json = JSON.stringify(v)
    .replace(/doctor_id/g, keep)
    .replace(/\bdoctors\b/g, 'dentists').replace(/\bdoctor\b/g, 'dentist')
    .replace(/\bDoctors\b/g, 'Dentists').replace(/\bDoctor\b/g, 'Dentist')
    .replace(new RegExp(keep, 'g'), 'doctor_id');
  return JSON.parse(json) as Vertical;
}
const DENTAL = withDentistWording(CLINIC);

export const VERTICALS: Record<string, Vertical> = { general: GENERAL, clinic: CLINIC, appointments: APPOINTMENTS, legal: LEGAL };

// What a neutral appointment business calls itself ("our salon").
const APPOINTMENT_PLACES: Record<string, string> = { salon: 'salon', spa: 'spa', fitness: 'studio', vet: 'clinic' };

/**
 * The business's vertical. A few kinds reword it: a dental practice says
 * "dentist", a salon says "our salon". A business without a vertical gets
 * `general`, unchanged.
 */
export function getVertical(meta: Pick<SectorMeta, 'vertical' | 'kind'> | null | undefined): Vertical {
  const v = (meta?.vertical && VERTICALS[meta.vertical]) || GENERAL;
  if (v === CLINIC && meta?.kind === 'dental') return DENTAL;
  if (v === APPOINTMENTS && meta?.kind && APPOINTMENT_PLACES[meta.kind]) return { ...v, place: APPOINTMENT_PLACES[meta.kind] };
  return v;
}

/** The vertical a newly chosen business type (sectors.kind) runs on. */
export function verticalForKind(kind: string): string {
  switch (kind) {
    case 'clinic': case 'dental': return 'clinic';
    case 'lawyer': return 'legal';
    case 'auto_shop': return 'general';
    default: return 'appointments';
  }
}

/** What the business calls the people callers book with: "Doctors", "Dentists", "Lawyers"… null if it books none. */
export function resourceNoun(meta: Pick<SectorMeta, 'vertical' | 'kind'> | null | undefined): string | null {
  return getVertical(meta).resources?.noun ?? null;
}

export const DEFAULT_ASSISTANT_NAME = 'Avery';

/** The assistant's spoken name for this business. */
export function assistantNameOf(meta: Pick<SectorMeta, 'assistantName'> | null | undefined): string {
  return meta?.assistantName?.trim() || DEFAULT_ASSISTANT_NAME;
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
