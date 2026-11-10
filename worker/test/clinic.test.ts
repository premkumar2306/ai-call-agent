import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './stubs/d1-sqlite';
import { getSectors } from '../src/services/sector.service';
import { getProducts } from '../src/services/catalog.service';
import {
  executeTool, getResourceSlots, getResourceBookings, checkWithinHours, parseHoursRanges,
  getToolDefinitions, normalizePhone, findResource, addLocalMinutes,
} from '../src/services/tool-router.service';
import { buildBusinessProfile, priceText } from '../src/services/business-profile';
import { buildAgentRules } from '../src/services/turn.service';
import { getVertical, VERTICALS, bookingDetailLines } from '../src/services/verticals';
import { bookingSummary } from '../src/services/notify.service';
import { createCallCache } from '../src/services/call-context';
import type { SectorMeta, SessionPayload } from '../src/types';

// The clinic vertical end to end against a real SQLite database migrated
// like D1 and loaded with seeds/demo_clinic_india.sql: three doctors with
// their own OPD hours, slot lengths, fees and services.

const SEED = readFileSync(new URL('../seeds/demo_clinic_india.sql', import.meta.url), 'utf8');
const BIZ = 'demo_clinic_india';

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}

let env: any;
let meta: SectorMeta;

// Monday 16 Nov 2026, 9:00 am in Bengaluru.
const NOW = new Date('2026-11-16T03:30:00Z');
const TUE = '2026-11-17';
const session = (sub = 'caller-1'): SessionPayload => ({
  sub, businessType: BIZ, callerPhone: '+919876543210', iat: 0, exp: 0, account: { tier: 'BASIC', store_credit_cents: 0 },
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const DB = createTestD1();
  DB.sqlite.exec(SEED);
  env = { DB, CACHE: kv(), CART: kv() };
  meta = (await getSectors(env))[BIZ];
});
afterEach(() => { vi.useRealTimers(); });

const book = (args: Record<string, unknown>, sub?: string, cache = createCallCache()) =>
  executeTool('book_appointment', args, session(sub), env, meta, cache);

describe('demo clinic seed', () => {
  it('loads as a clinic with three doctors, INR and Asia/Kolkata', () => {
    expect(meta.vertical).toBe('clinic');
    expect(meta.currency).toBe('INR');
    expect(meta.timezone).toBe('Asia/Kolkata');
    expect(meta.name).toMatch(/demo/i);
    expect(meta.hours.sun).toBeUndefined();
    expect(meta.resources!.map(r => r.name)).toEqual(['Dr. Ananya Rao', 'Dr. Vikram Mehta', 'Dr. Farah Khan']);
    expect(meta.resources![0]).toMatchObject({ slotMinutes: 15, feeCents: 50000 });
  });
});

describe('split OPD hours', () => {
  it('parses a morning and an evening session', () => {
    expect(parseHoursRanges('10am–1pm, 5pm–9pm')).toEqual([
      { openH: 10, openM: 0, closeH: 13, closeM: 0 },
      { openH: 17, openM: 0, closeH: 21, closeM: 0 },
    ]);
    expect(parseHoursRanges('7:30am–6pm')).toHaveLength(1);
    expect(parseHoursRanges('closed')).toEqual([]);
  });

  it('allows times inside either session, not across the lunch gap', () => {
    expect(checkWithinHours(`${TUE}T10:00:00`, 15, meta, NOW)).toBeNull();
    expect(checkWithinHours(`${TUE}T12:45:00`, 15, meta, NOW)).toBeNull();
    expect(checkWithinHours(`${TUE}T12:50:00`, 15, meta, NOW)).toBe('OUTSIDE_HOURS');
    expect(checkWithinHours(`${TUE}T14:00:00`, 15, meta, NOW)).toBe('OUTSIDE_HOURS');
    expect(checkWithinHours(`${TUE}T20:45:00`, 15, meta, NOW)).toBeNull();
    expect(checkWithinHours('2026-11-22T10:00:00', 15, meta, NOW)).toBe('OUTSIDE_HOURS'); // Sunday
  });
});

describe('doctor availability', () => {
  it("follows each doctor's own hours and slot length", () => {
    const rao = getResourceSlots(meta, { resourceId: 'demo-dr-rao', bookings: [], now: NOW });
    const tue = rao.filter(s => s.date === TUE).map(s => s.time);
    expect(tue.slice(0, 3)).toEqual(['10:00 AM', '10:15 AM', '10:30 AM']);
    expect(tue).toContain('12:45 PM');
    expect(tue).not.toContain('1:00 PM');
    expect(tue).toContain('5:00 PM');
    expect(tue[tue.length - 1]).toBe('8:45 PM');
    // Dr. Mehta only sits Tuesday evenings; Dr. Khan has 30-minute slots.
    const mehta = getResourceSlots(meta, { resourceId: 'demo-dr-mehta', bookings: [], now: NOW }).filter(s => s.date === TUE);
    expect(mehta[0].time).toBe('5:00 PM');
    const khan = getResourceSlots(meta, { resourceId: 'demo-dr-khan', bookings: [], now: NOW }).filter(s => s.date === TUE);
    expect(khan.slice(0, 2).map(s => s.time)).toEqual(['10:00 AM', '10:30 AM']);
    expect(rao.some(s => s.date === '2026-11-22')).toBe(false); // Sunday closed
  });

  it("offers only doctors who do the service, and says who it's with", () => {
    const slots = getResourceSlots(meta, { category: 'DENTAL', durationMinutes: 30, bookings: [], now: NOW });
    expect(new Set(slots.map(s => s.resource!.id))).toEqual(new Set(['demo-dr-khan']));
    const any = getResourceSlots(meta, { bookings: [], now: NOW });
    expect(any[0].label).toMatch(/ with Dr\. /);
  });

  it("drops times that overlap the doctor's bookings, and only that doctor's", () => {
    const bookings = [{ resourceId: 'demo-dr-rao', start: `${TUE}T10:00`, end: `${TUE}T10:30` }];
    const rao = getResourceSlots(meta, { resourceId: 'demo-dr-rao', bookings, now: NOW }).filter(s => s.date === TUE);
    expect(rao[0].time).toBe('10:30 AM');
    const khan = getResourceSlots(meta, { resourceId: 'demo-dr-khan', bookings, now: NOW }).filter(s => s.date === TUE);
    expect(khan[0].time).toBe('10:00 AM');
    // Any doctor: 10:00 is still open, with someone else.
    const any = getResourceSlots(meta, { bookings, now: NOW }).filter(s => s.date === TUE);
    expect(any[0]).toMatchObject({ time: '10:00 AM', resource: { id: 'demo-dr-khan' } });
  });

  it('finds a doctor by id or by how a caller says the name', () => {
    expect(findResource(meta, 'demo-dr-khan')?.name).toBe('Dr. Farah Khan');
    expect(findResource(meta, 'Dr Mehta')?.id).toBe('demo-dr-mehta');
    expect(findResource(meta, 'ananya rao')?.id).toBe('demo-dr-rao');
    expect(findResource(meta, 'Dr Sharma')).toBeUndefined();
  });

  it('check_availability returns the doctor_id to book each opening with', async () => {
    const res = await executeTool('check_availability', { service_id: 'demo-clinic-dental-consult', preferred_date: TUE, preferred_time: '17:30' }, session(), env, meta, createCallCache());
    expect(res.data).toMatchObject({ requested_open: true, requested_slot: { datetime: `${TUE}T17:30:00`, doctor_id: 'demo-dr-khan', doctor: 'Dr. Farah Khan' } });
  });

  it('says when the doctor asked for does not do that service', async () => {
    const res = await executeTool('check_availability', { service_id: 'demo-clinic-scaling', doctor_id: 'demo-dr-mehta' }, session(), env, meta, createCallCache());
    expect(res.error).toBe('NOT_OFFERED_BY_RESOURCE');
    expect(res.spoken_response).toMatch(/Dr\. Farah Khan does/);
  });
});

describe('clinic booking', () => {
  const base = { product_id: 'demo-clinic-consult', scheduled_at: `${TUE}T10:00:00`, doctor_id: 'demo-dr-rao' };

  it("asks for the patient's name, then new or returning (or age)", async () => {
    const noName = await book(base);
    expect(noName).toMatchObject({ error: 'DETAILS_REQUIRED', spoken_response: VERTICALS.clinic.askName });
    const noStatus = await book({ ...base, customer_name: 'Asha Verma', reason_for_visit: 'fever' });
    expect(noStatus).toMatchObject({ error: 'DETAILS_REQUIRED', spoken_response: VERTICALS.clinic.askMissing });
    const withAge = await book({ ...base, customer_name: 'Asha Verma', patient_age: '34' });
    expect(withAge.success).toBe(true);
  });

  it("books the doctor at their fee and records the patient's details", async () => {
    const res = await book({ ...base, customer_name: 'Asha Verma', patient_status: 'New', reason_for_visit: 'fever for three days' });
    expect(res.success).toBe(true);
    expect(res.spoken_response).toBe("You're all set, Asha Verma — General Consultation with Dr. Ananya Rao tomorrow at 10:00 AM. Anything else I can help with?");
    expect(res.data).toMatchObject({ doctor: 'Dr. Ananya Rao', price: '500 rupees' });
    const row = env.DB.sqlite.prepare('SELECT * FROM orders').get();
    expect(row).toMatchObject({
      resource_id: 'demo-dr-rao', resource_name: 'Dr. Ananya Rao', price_cents: 50000,
      scheduled_at: `${TUE}T10:00:00`, ends_at: `${TUE}T10:15:00`, callback_phone: '+919876543210',
    });
    expect(JSON.parse(row.details)).toEqual({ patient_status: 'new', reason_for_visit: 'fever for three days' });
    expect(row.vehicle).toBeNull();
  });

  it("won't double-book a doctor, including an overlap from a longer appointment", async () => {
    // A 30-minute health check at 10:00 blocks Dr. Rao's 10:15 slot.
    const first = await book({ ...base, product_id: 'demo-clinic-health-check', customer_name: 'A', patient_age: '50' }, 'caller-1');
    expect(first.success).toBe(true);
    const clash = await book({ ...base, scheduled_at: `${TUE}T10:15:00`, customer_name: 'B', patient_age: '40' }, 'caller-2');
    expect(clash.error).toBe('SLOT_TAKEN');
    const after = await book({ ...base, scheduled_at: `${TUE}T10:30:00`, customer_name: 'B', patient_age: '40' }, 'caller-2');
    expect(after.success).toBe(true);
    const bookings = await getResourceBookings(env, BIZ);
    expect(bookings).toContainEqual({ resourceId: 'demo-dr-rao', start: `${TUE}T10:00`, end: `${TUE}T10:30` });
  });

  it('with no doctor named, books whoever does the service and is free', async () => {
    const taken = await book({ product_id: 'demo-clinic-follow-up', scheduled_at: `${TUE}T10:00:00`, customer_name: 'A', patient_status: 'returning' }, 'caller-1');
    expect(taken.data).toMatchObject({ doctor: 'Dr. Ananya Rao' });
    const next = await book({ product_id: 'demo-clinic-follow-up', scheduled_at: `${TUE}T10:00:00`, customer_name: 'B', patient_status: 'returning' }, 'caller-2');
    expect(next.data).toMatchObject({ doctor: 'Dr. Farah Khan' });
  });

  it("rejects a time outside the named doctor's OPD hours, naming the doctor", async () => {
    // Dr. Mehta sits Tuesday evenings only.
    const res = await book({ product_id: 'demo-clinic-child-consult', scheduled_at: `${TUE}T10:00:00`, doctor_id: 'demo-dr-mehta', customer_name: 'Riya', patient_age: '6' });
    expect(res.error).toBe('OUTSIDE_HOURS');
    expect(res.spoken_response).toMatch(/Dr\. Vikram Mehta isn't in then/);
  });

  it('corrects details without losing the others, and reschedules with the same doctor', async () => {
    const cache = createCallCache();
    const made = await book({ ...base, customer_name: 'Asha', patient_status: 'new', reason_for_visit: 'fever' }, 'caller-1', cache);
    const id = (made.data as any).id;
    const upd = await executeTool('update_booking', { order_id: id, patient_age: '34' }, session(), env, meta, cache);
    expect(upd.success).toBe(true);
    expect(JSON.parse(env.DB.sqlite.prepare('SELECT details FROM orders WHERE id = ?').get(id).details))
      .toEqual({ patient_status: 'new', reason_for_visit: 'fever', patient_age: '34' });
    const moved = await executeTool('reschedule_booking', { order_id: id, new_datetime: `${TUE}T17:15:00` }, session(), env, meta, cache);
    expect(moved.success).toBe(true);
    const row = env.DB.sqlite.prepare("SELECT * FROM orders WHERE status != 'CANCELLED'").get();
    expect(row).toMatchObject({ resource_id: 'demo-dr-rao', scheduled_at: `${TUE}T17:15:00`, ends_at: `${TUE}T17:30:00`, price_cents: 50000 });
  });

  it('tells staff who the patient is and which doctor', () => {
    const order = { vehicle: null, resourceName: 'Dr. Ananya Rao', details: { patient_status: 'new', patient_age: '34', reason_for_visit: 'fever' } };
    expect(bookingDetailLines(order)).toEqual(['With: Dr. Ananya Rao', 'New or returning: new', 'Age: 34', 'Reason for visit: fever']);
    const summary = bookingSummary({ id: 'abcdef123', productName: 'General Consultation', scheduledAt: `${TUE}T10:00:00`, customerName: 'Asha', callbackPhone: '+919876543210', ...order } as any);
    expect(summary).toContain('With: Dr. Ananya Rao');
    expect(summary).not.toContain('Vehicle');
  });
});

describe('clinic prompt and tools', () => {
  it('carries the medical safety rules: no advice, 112 for emergencies, offer a transfer', () => {
    const rules = buildAgentRules(BIZ, meta.name, 'voice', getVertical(meta));
    expect(rules).toMatch(/Never give medical advice or a diagnosis/);
    expect(rules).toMatch(/call 112 now or go to the nearest emergency department/);
    expect(rules).toMatch(/offer to connect them to the clinic staff \(transfer_to_staff\)/);
    expect(rules).not.toMatch(/vehicle|service advisor/i);
    const general = buildAgentRules('advanced_vtech', 'Advanced VTech', 'voice');
    expect(general).not.toMatch(/112|MEDICAL SAFETY/);
  });

  it('lists doctors with OPD hours and fees, and prices consultations by doctor', async () => {
    const products = await getProducts(env, BIZ);
    const profile = buildBusinessProfile(BIZ, meta, products);
    expect(profile).toMatch(/- Dr\. Ananya Rao \[doctor_id: demo-dr-rao\] — General physician \(MBBS, MD\)\. Hours: Monday 10am to 1pm, 5pm to 9pm;.* Sunday closed\. Consultation fee: 500 rupees\. 15-minute appointments\./);
    expect(profile).toMatch(/General Consultation \[id: demo-clinic-consult\] — 500 rupees/);
    expect(profile).toMatch(/Dental Consultation \[id: demo-clinic-dental-consult\] — 400 rupees/);
    expect(profile).toMatch(/Teeth Cleaning .* — 1200 rupees, about 30 min/);
    expect(profile).toMatch(/Root Canal Treatment .* — the doctor confirms the cost at the visit/);
    expect(profile).toMatch(/Follow-up Visit .* — free/);
    // A consultation two doctors do at different fees reads as "depends".
    const mixed = { ...meta, resources: meta.resources!.map(r => ({ ...r, categories: undefined })) };
    expect(priceText(products.find(p => p.id === 'demo-clinic-consult')!, mixed)).toBe('fee depends on the doctor');
  });

  it('asks for patient details and a doctor instead of a vehicle', () => {
    const tools = getToolDefinitions(BIZ, meta);
    const props = (name: string) => (tools.find(t => t.name === name)!.parameters as any).properties;
    expect(props('book_appointment').vehicle).toBeUndefined();
    expect(props('book_appointment').patient_status.enum).toEqual(['new', 'returning']);
    expect(props('book_appointment').reason_for_visit).toBeDefined();
    expect(props('book_appointment').doctor_id.enum).toEqual(['demo-dr-rao', 'demo-dr-mehta', 'demo-dr-khan']);
    expect(props('check_availability').doctor_id).toBeDefined();
    expect(props('update_booking').patient_age).toBeDefined();
    const us = getToolDefinitions('advanced_vtech', null);
    expect((us.find(t => t.name === 'book_appointment')!.parameters as any).properties.doctor_id).toBeUndefined();
  });

  it('hands over to the front desk, and says the clinic is closed after hours', async () => {
    const withPhone = { ...meta, phone: '+91 80 0000 0000' };
    const cache = createCallCache();
    vi.setSystemTime(new Date('2026-11-16T05:00:00Z')); // Monday 10:30 am IST
    const open = await executeTool('transfer_to_staff', {}, session(), env, withPhone, cache);
    expect(open.spoken_response).toMatch(/connecting you to the front desk/);
    vi.setSystemTime(new Date('2026-11-16T08:30:00Z')); // 2 pm: lunch gap
    const closed = await executeTool('transfer_to_staff', {}, session(), env, withPhone, createCallCache());
    expect(closed.spoken_response).toMatch(/^The clinic is closed right now/);
  });
});

describe('Indian phone numbers', () => {
  it('normalises numbers said without +91 for Indian businesses only', () => {
    expect(normalizePhone('98765 43210', '91')).toBe('+919876543210');
    expect(normalizePhone('098765 43210', '91')).toBe('+919876543210');
    expect(normalizePhone('91 98765 43210', '91')).toBe('+919876543210');
    expect(normalizePhone('+1 847 555 1234', '91')).toBe('+18475551234');
    expect(normalizePhone('847 555 1234')).toBe('+18475551234');
  });

  it('adds minutes to a local wall-clock time', () => {
    expect(addLocalMinutes('2026-11-17T12:45:00', 30)).toBe('2026-11-17T13:15:00');
  });
});
