import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './stubs/d1-sqlite';
import { getSectors } from '../src/services/sector.service';
import { getProducts } from '../src/services/catalog.service';
import { executeTool, getToolDefinitions } from '../src/services/tool-router.service';
import { buildBusinessProfile } from '../src/services/business-profile';
import { buildSystemPrompt } from '../src/services/turn.service';
import { getVertical, VERTICALS, bookingDetailLines } from '../src/services/verticals';
import { callStartNotice, disclosureEnabled } from '../src/services/disclosure';
import { voiceLines } from '../src/services/voice-language';
import { createCallCache } from '../src/services/call-context';
import type { SectorMeta, SessionPayload } from '../src/types';

// The legal vertical end to end against a SQLite database migrated like D1
// and loaded with seeds/demo_law_firm_india.sql: three lawyers with their own
// hours, fees and practice areas.

const SEED = readFileSync(new URL('../seeds/demo_law_firm_india.sql', import.meta.url), 'utf8');
const BIZ = 'demo_law_firm_india';

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}

let env: any;
let meta: SectorMeta;

// Monday 16 Nov 2026, 9:00 am in Pune.
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

const book = (args: Record<string, unknown>, sub?: string) =>
  executeTool('book_appointment', args, session(sub), env, meta, createCallCache());

const rules = () => buildSystemPrompt({ businessType: BIZ, sectorMeta: meta, products: [], session: session(), orders: [] })[0].text;

describe('demo law firm seed', () => {
  it('loads as a fictional Indian law firm with three lawyers', () => {
    expect(meta).toMatchObject({ vertical: 'legal', kind: 'lawyer', currency: 'INR', timezone: 'Asia/Kolkata', countryCode: 'IN' });
    expect(meta.name).toMatch(/demo/i);
    expect(meta.about).toMatch(/demo law firm .* not a real firm/i);
    expect(meta.resources!.map(r => r.name)).toEqual(['Adv. Meera Kulkarni', 'Adv. Imran Shaikh', 'Adv. Rohan Iyer']);
    expect(meta.resources![1]).toMatchObject({ slotMinutes: 30, feeCents: 100000, categories: ['CRIMINAL', 'CONSUMER'] });
  });
});

describe('legal booking', () => {
  const base = { product_id: 'demo-law-consumer', scheduled_at: `${TUE}T10:00:00`, lawyer_id: 'demo-adv-shaikh' };

  it('asks for the name, then the kind of matter', async () => {
    expect(await book(base)).toMatchObject({ error: 'DETAILS_REQUIRED', spoken_response: VERTICALS.legal.askName });
    expect(await book({ ...base, customer_name: 'Neha Joshi' })).toMatchObject({ error: 'DETAILS_REQUIRED', spoken_response: VERTICALS.legal.askMissing });
  });

  it("books the lawyer at their consultation fee and records the matter for the conflict check", async () => {
    const res = await book({
      ...base, customer_name: 'Neha Joshi', matter_type: 'Consumer', matter_summary: 'builder delayed flat possession',
      opposing_party: 'Demo Builders Pvt Ltd', client_status: 'new', urgency: 'routine',
    });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ price: '₹1,000' });
    const row = env.DB.sqlite.prepare('SELECT * FROM orders').get();
    expect(row).toMatchObject({ resource_id: 'demo-adv-shaikh', price_cents: 100000, ends_at: `${TUE}T10:30:00` });
    expect(JSON.parse(row.details)).toEqual({
      client_status: 'new', matter_type: 'consumer', matter_summary: 'builder delayed flat possession',
      opposing_party: 'Demo Builders Pvt Ltd', urgency: 'routine',
    });
    expect(bookingDetailLines({ vehicle: null, resourceName: 'Adv. Imran Shaikh', details: JSON.parse(row.details) }))
      .toContain('Opposing party (for conflict check): Demo Builders Pvt Ltd');
  });

  it("only offers lawyers who handle that practice area", async () => {
    const res = await book({ ...base, lawyer_id: 'demo-adv-iyer', customer_name: 'N', matter_type: 'consumer' });
    expect(res.error).toBe('NOT_OFFERED_BY_RESOURCE');
    expect(res.spoken_response).toMatch(/Adv\. Imran Shaikh does/);
  });
});

describe('legal prompt, tools and notice', () => {
  it('carries the legal safety rules', () => {
    const r = rules();
    expect(r).toMatch(/Never give legal advice/);
    expect(r).toMatch(/Never promise or suggest a result/);
    expect(r).toMatch(/only the consultation fees listed here/i);
    expect(r).toMatch(/lawyer will discuss it with them in confidence/);
    expect(r).toMatch(/arrested or in police custody, a court hearing or deadline within 48 hours, or domestic violence/);
    expect(r).toMatch(/transfer_to_staff/);
    expect(r).toMatch(/call 112/);
    expect(r).toMatch(/Bar Council of India/);
    expect(r).toMatch(/never sell or praise the firm/);
    expect(r).toMatch(/^You are Avery, the friendly receptionist for Demo Nyaya Legal Associates/);
    expect(r).not.toMatch(/vehicle|service advisor|MEDICAL/i);
  });

  it('lists lawyers and prices practice-area consultations by lawyer', async () => {
    const profile = buildBusinessProfile(BIZ, meta, await getProducts(env, BIZ));
    expect(profile).toMatch(/Lawyers \(book with the lawyer's \[lawyer_id\]\):/);
    expect(profile).toMatch(/- Adv\. Rohan Iyer \[lawyer_id: demo-adv-iyer\].* Consultation fee: ₹2,000\. 45-minute appointments\./);
    expect(profile).toMatch(/Criminal Law Consultation \[id: demo-law-criminal\] — ₹1,000/);
    expect(profile).toMatch(/Document Drafting Appointment .* — ₹2,500/);
  });

  it('asks for matter details and a lawyer, not a vehicle', () => {
    const props = (name: string) => (getToolDefinitions(BIZ, meta).find(t => t.name === name)!.parameters as any).properties;
    const b = props('book_appointment');
    expect(b.vehicle).toBeUndefined();
    expect(b.matter_type.enum).toEqual(['family', 'property', 'criminal', 'corporate', 'consumer', 'labour', 'other']);
    expect(b.client_status.enum).toEqual(['new', 'existing']);
    expect(b.urgency.enum).toEqual(['routine', 'urgent']);
    expect(b.opposing_party).toBeDefined();
    expect(b.lawyer_id.enum).toEqual(['demo-adv-kulkarni', 'demo-adv-shaikh', 'demo-adv-iyer']);
  });

  it('turns the AI / recording notice on by default in any country, unless switched off', () => {
    expect(disclosureEnabled(meta)).toBe(true);
    const us = { ...meta, countryCode: 'US', timezone: 'America/Chicago', currency: 'USD' };
    expect(disclosureEnabled(us)).toBe(true);
    expect(disclosureEnabled({ ...us, aiDisclosure: false })).toBe(false);
    expect(disclosureEnabled({ ...us, vertical: undefined })).toBe(false);
    expect(callStartNotice({ ...us, voice: { language: 'hi', sttProvider: 'sarvam', ttsProvider: 'sarvam' } })).toMatch(/AI सहायक/);
  });

  it('greets in English, Hindi and Hinglish with a lawyer-specific hint', () => {
    expect(voiceLines('en').capabilityHint(BIZ, 'legal')).toMatch(/consultation with one of our lawyers/);
    expect(voiceLines('hi').capabilityHint(BIZ, 'legal')).toMatch(/वकील/);
    expect(voiceLines('hi-en').capabilityHint(BIZ, 'legal')).toMatch(/वकील/);
    expect(voiceLines('en').capabilityHint('advanced_vtech', 'general')).toBe('I can answer questions about our services and prices, or book you in — what can I do for you?');
  });

  it('says the office is the desk on a transfer', async () => {
    vi.setSystemTime(new Date('2026-11-16T05:00:00Z')); // Monday 10:30 am IST
    const open = await executeTool('transfer_to_staff', {}, session(), env, { ...meta, phone: '+91 20 0000 0000' }, createCallCache());
    expect(open.spoken_response).toMatch(/connecting you to the office/);
    expect(getVertical(meta).key).toBe('legal');
  });
});
