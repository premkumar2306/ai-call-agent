import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import {
  addMonths, getBookedIntervals, markVisit, overlappingPatients, runClinicFollowUps, saveClinicFeatures, validateClinicFeatures,
} from '../src/services/clinic-features';
import { placeOrder } from '../src/services/order.service';
import { recordMessagingConsent } from '../src/services/whatsapp-outbound';
import { hashId } from '../src/utils/identity';
import { clinicRouter } from '../src/routes/clinic';

let env: Env;
let sms: Array<{ to: string; body: string }>;
const SALT = 'salt';

beforeEach(async () => {
  env = {
    DB: createD1() as any, CACHE: createKV() as any, NODE_ENV: 'development', ADMIN_SECRET: 'admin', CUSTOMER_HASH_SALT: SALT,
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550000000',
  } as Env;
  sms = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit = {}) => {
    const p = new URLSearchParams(String(init.body)); sms.push({ to: p.get('To')!, body: p.get('Body')! }); return Response.json({ sid: 'SM1' });
  }));
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, capacity, created_at, updated_at) VALUES ('in_d', 'Smile Dental', 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 'IN', 2, 0, 0)`).run();
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, created_at, updated_at) VALUES ('us_biz', 'US', 'service', '[]', '{}', 0, 0)`).run();
  await env.DB.prepare(`INSERT INTO vendors (id, name, business_type, contact_email, created_at) VALUES ('v1', 'x', 'in_d', 'x@x', 0)`).run();
  for (const [id, name, cat, mins] of [['clean', 'Cleaning', 'cleaning', 30], ['rct', 'Root canal', 'endo', 90]] as const) {
    await env.DB.prepare(`INSERT INTO products (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type, description, price_cents, original_price_cents, duration_minutes, created_at) VALUES (?, 'in_d', 'v1', 'x', ?, ?, 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING', '', 50000, 50000, ?, 0)`).bind(id, name, cat, mins).run();
  }
});
afterEach(() => vi.unstubAllGlobals());

async function order(id: string, who: string, product: string, at: string, phone = '+919800000001') {
  await env.DB.prepare(`INSERT INTO orders (id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status, price_cents, payment_method, scheduled_at, callback_phone, created_at, updated_at) VALUES (?, ?, 'in_d', ?, 'x', ?, 'CONFIRMED', 50000, 'cash', ?, ?, 0, 0)`)
    .bind(id, who, product, product === 'rct' ? 'Root canal' : 'Cleaning', at, phone).run();
}

describe('duration booking', () => {
  it('intervals use each service duration; overlap counts distinct other patients', async () => {
    await order('o1', 'a', 'rct', '2030-01-10T10:00');    // 10:00–11:30
    await order('o2', 'b', 'clean', '2030-01-10T10:30');  // 10:30–11:00
    const iv = await getBookedIntervals(env, 'in_d', '2030-01-10T00:00');
    expect(iv.find(i => i.customer === 'a')).toMatchObject({ start: '2030-01-10T10:00', end: '2030-01-10T11:30' });
    expect(overlappingPatients(iv, '2030-01-10T10:45', '2030-01-10T11:15')).toBe(2); // both chairs busy
    expect(overlappingPatients(iv, '2030-01-10T11:00', '2030-01-10T11:30')).toBe(1);
    expect(overlappingPatients(iv, '2030-01-10T11:30', '2030-01-10T12:00')).toBe(0);
    expect(overlappingPatients(iv, '2030-01-10T10:45', '2030-01-10T11:15', 'a')).toBe(1);
    // Asking from a later time still sees a visit that started earlier and runs on.
    const later = await getBookedIntervals(env, 'in_d', '2030-01-10T11:00');
    expect(overlappingPatients(later, '2030-01-10T11:00', '2030-01-10T11:30')).toBe(1);
  });
  it('booking refuses a slot when all chairs are taken for any part of the procedure', async () => {
    await order('o1', 'a', 'rct', '2030-01-10T10:00');
    await order('o2', 'b', 'clean', '2030-01-10T10:30');
    await expect(placeOrder(env, 'c', 'in_d', 'clean', 'cash', undefined, '2030-01-10T10:45', { capacity: 2, durationMinutes: 30 }))
      .rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const ok = await placeOrder(env, 'c', 'in_d', 'clean', 'cash', undefined, '2030-01-10T11:00', { capacity: 2, durationMinutes: 30 });
    expect(ok.endsAt).toBe('2030-01-10T11:30');
    // Without the switch (no durationMinutes) the old rule applies: only the same start time counts.
    const legacy = await placeOrder(env, 'd', 'in_d', 'clean', 'cash', undefined, '2030-01-10T10:45', { capacity: 2 });
    expect(legacy.endsAt ?? null).toBeNull();
  });
});

describe('switches', () => {
  it('validate and require a Google review link for review requests', async () => {
    expect(validateClinicFeatures({ reviewUrl: 'https://evil.example/review' })).toMatch(/Google review link/);
    expect(validateClinicFeatures({ recallMonths: 0 })).toMatch(/1–36/);
    await expect(saveClinicFeatures(env, 'in_d', { reviewRequests: true })).rejects.toMatchObject({ status: 400 });
    const f = await saveClinicFeatures(env, 'in_d', { reviewRequests: true, reviewUrl: 'https://g.page/r/abc/review' });
    expect(f).toMatchObject({ reviewRequests: true, recalls: false, noShowRecovery: false, durationBooking: false });
  });
  it('routes: staff mark visits; GET shows everything off by default', async () => {
    const H = { 'X-Admin-Key': 'admin', 'Content-Type': 'application/json' };
    const got: any = await (await clinicRouter.request('/us_biz', { headers: H }, env)).json();
    expect(got.data).toMatchObject({ durationBooking: false, recalls: false, noShowRecovery: false, reviewRequests: false });
    await order('o1', 'a', 'clean', '2030-01-10T10:00');
    expect((await clinicRouter.request('/in_d/visits/o1', { method: 'POST', headers: H, body: JSON.stringify({ status: 'no_show' }) }, env)).status).toBe(200);
    expect((await clinicRouter.request('/in_d/visits/nope', { method: 'POST', headers: H, body: JSON.stringify({ status: 'no_show' }) }, env)).status).toBe(404);
    expect((await clinicRouter.request('/in_d/visits/o1', { method: 'POST', headers: H, body: JSON.stringify({ status: 'maybe' }) }, env)).status).toBe(400);
  });
});

describe('hourly follow-ups', () => {
  it('nothing runs while every switch is off', async () => {
    await order('o1', 'a', 'clean', '2026-11-10T10:00');
    await markVisit(env, 'in_d', 'o1', 'no_show');
    expect(await runClinicFollowUps(env)).toEqual([]);
    expect(sms).toHaveLength(0);
  });
  it('no-show: rebook message once, plus a callback task for staff; opt-out respected', async () => {
    await saveClinicFeatures(env, 'in_d', { noShowRecovery: true });
    await order('o1', 'a', 'clean', '2026-11-10T10:00', '+919800000001');
    await order('o2', 'b', 'clean', '2026-11-10T11:00', '+919800000002');
    await markVisit(env, 'in_d', 'o1', 'no_show');
    await markVisit(env, 'in_d', 'o2', 'no_show');
    await recordMessagingConsent(env, { businessType: 'in_d', phoneHash: await hashId('919800000002', SALT), action: 'opt_out', source: 'test' });
    const r = await runClinicFollowUps(env);
    expect(r.map(x => [x.orderId, x.job, x.outcome])).toEqual([['o1', 'no_show', 'sms'], ['o2', 'no_show', 'skipped:opted_out']]);
    expect(sms[0].body).toMatch(/we missed you at your Cleaning/);
    const { results } = await env.DB.prepare(`SELECT message FROM call_messages WHERE business_type = 'in_d'`).all<{ message: string }>();
    expect(results).toHaveLength(2);
    expect(results![0].message).toMatch(/call to rebook/);
    expect(await runClinicFollowUps(env)).toEqual([]); // once
  });
  it('review: every completed visit after 2 hours, same link for all (no gating)', async () => {
    await saveClinicFeatures(env, 'in_d', { reviewRequests: true, reviewUrl: 'https://g.page/r/abc/review' });
    await order('o1', 'a', 'clean', '2026-11-10T10:00');
    await markVisit(env, 'in_d', 'o1', 'completed');
    expect(await runClinicFollowUps(env)).toEqual([]); // too soon
    const later = new Date(Date.now() + 3 * 3600_000);
    const r = await runClinicFollowUps(env, later);
    expect(r).toEqual([{ businessType: 'in_d', orderId: 'o1', job: 'review', outcome: 'sms' }]);
    expect(sms[0].body).toContain('https://g.page/r/abc/review');
  });
  it('recall: N months after a completed visit in the category, unless already rebooked', async () => {
    await saveClinicFeatures(env, 'in_d', { recalls: true, recallMonths: 6, recallCategory: 'cleaning' });
    const now = new Date('2026-11-16T06:00:00Z');
    await order('due', 'a', 'clean', '2026-05-16T10:00', '+919800000001');
    await order('rebooked', 'b', 'clean', '2026-05-15T10:00', '+919800000002');
    await order('later', 'b', 'clean', '2026-12-01T10:00', '+919800000002');
    await order('other', 'c', 'rct', '2026-05-16T12:00', '+919800000003');
    await order('notyet', 'd', 'clean', '2026-06-01T10:00', '+919800000004');
    for (const id of ['due', 'rebooked', 'other', 'notyet']) await markVisit(env, 'in_d', id, 'completed');
    const r = await runClinicFollowUps(env, now);
    expect(r.map(x => x.orderId)).toEqual(['due']);
    expect(sms[0].body).toMatch(/about 6 months since your last Cleaning/);
  });
  it('addMonths clamps the day', () => {
    expect(addMonths('2026-08-31', -6)).toBe('2026-02-28');
    expect(addMonths('2026-11-16', -6)).toBe('2026-05-16');
  });
});

describe('no-show rate in pilot metrics', async () => {
  const { noShowRates } = await import('../src/services/metrics');
  it('not tracked until visits are marked; then no_show ÷ marked, before vs after', async () => {
    const from = Date.parse('2026-11-01T00:00:00+05:30') / 1000, to = Date.parse('2026-11-15T00:00:00+05:30') / 1000;
    expect(await noShowRates(env, 'in_d', 'Asia/Kolkata', from, to)).toEqual({ status: 'not_tracked' });
    await order('b1', 'a', 'clean', '2026-10-20T10:00'); await markVisit(env, 'in_d', 'b1', 'no_show');
    await order('b2', 'b', 'clean', '2026-10-21T10:00'); await markVisit(env, 'in_d', 'b2', 'completed');
    await order('a1', 'c', 'clean', '2026-11-05T10:00'); await markVisit(env, 'in_d', 'a1', 'completed');
    await order('a2', 'd', 'clean', '2026-11-06T10:00'); await markVisit(env, 'in_d', 'a2', 'completed');
    await order('a3', 'e', 'clean', '2026-11-07T10:00'); await markVisit(env, 'in_d', 'a3', 'completed');
    await order('a4', 'f', 'clean', '2026-11-08T10:00'); await markVisit(env, 'in_d', 'a4', 'no_show');
    expect(await noShowRates(env, 'in_d', 'Asia/Kolkata', from, to)).toEqual({ status: 'ok', before: 0.5, after: 0.25 });
  });
});
