import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import { computeMetrics, isAfterHours, recordCallOutcome, runWeeklySummaries, saveMetricsSettings, summaryText, weekStart } from '../src/services/metrics';
import { recordCallRouting, savePilotConfig } from '../src/services/pilot';
import { metricsRouter, publicReportRouter } from '../src/routes/metrics';

let env: Env;
let emails: Array<{ to: string; subject: string; text: string }>;
const HOURS = { mon: '9am–1pm, 5pm–9pm', tue: '9am–1pm, 5pm–9pm', wed: '9am–1pm, 5pm–9pm', thu: '9am–1pm, 5pm–9pm', fri: '9am–1pm, 5pm–9pm', sat: '9am–1pm', sun: 'Closed' };
// Wed 18 Nov 2026, 10:00 IST = 04:30Z (open); 22:00 IST = 16:30Z (after hours)
const OPEN = Date.parse('2026-11-18T04:30:00Z') / 1000, CLOSED = Date.parse('2026-11-18T16:30:00Z') / 1000;

beforeEach(async () => {
  env = { DB: createD1() as any, CACHE: createKV() as any, NODE_ENV: 'development', ADMIN_SECRET: 'admin', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' } as Env;
  emails = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit = {}) => {
    const b = JSON.parse(String(init.body)); emails.push({ to: b.to[0], subject: b.subject, text: b.text }); return Response.json({ id: 'e' });
  }));
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, notify_email, created_at, updated_at) VALUES ('in_c', 'Sharma Dental', 'service', '[]', ?, 'Asia/Kolkata', 'INR', 'IN', 'owner@c.in', 0, 0)`).bind(JSON.stringify(HOURS)).run();
  await env.DB.prepare(`INSERT INTO vendors (id, name, business_type, contact_email, created_at) VALUES ('v1', 'x', 'in_c', 'x@x', 0)`).run();
  await env.DB.prepare(`INSERT INTO products (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type, description, price_cents, original_price_cents, created_at) VALUES ('p1', 'in_c', 'v1', 'x', 'Cleaning', 'dental', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING', '', 50000, 50000, 0)`).run();
});
afterEach(() => vi.unstubAllGlobals());

async function call(sid: string, startedAt: number, o: Partial<{ userTurns: number; transferred: boolean; caller: string; isTest: boolean }> = {}) {
  await recordCallOutcome(env, { carrier: 'plivo', callSid: sid, businessType: 'in_c', callerHash: o.caller ?? `h-${sid}`, startedAt, endedAt: startedAt + 120,
    userTurns: o.userTurns ?? 3, transferred: o.transferred ?? false, messageTaken: false, isTest: o.isTest ?? false });
}
async function booking(id: string, caller: string, at: number, status = 'CONFIRMED') {
  await env.DB.prepare(`INSERT INTO orders (id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status, price_cents, payment_method, created_at, updated_at) VALUES (?, ?, 'in_c', 'p1', 'x', 'Cleaning', ?, 50000, 'cash', ?, ?)`).bind(id, caller, status, at, at).run();
}

describe('after-hours', () => {
  it('uses the weekday ranges in the business time zone', () => {
    expect(isAfterHours(HOURS, 'Asia/Kolkata', new Date(OPEN * 1000))).toBe(false);
    expect(isAfterHours(HOURS, 'Asia/Kolkata', new Date(CLOSED * 1000))).toBe(true);
    expect(isAfterHours(HOURS, 'Asia/Kolkata', new Date('2026-11-18T09:00:00Z'))).toBe(true); // 14:30 IST, lunch gap
    expect(isAfterHours(HOURS, 'Asia/Kolkata', new Date('2026-11-22T05:00:00Z'))).toBe(true); // Sunday closed
    expect(isAfterHours({}, 'Asia/Kolkata', new Date())).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('no calls → nulls, not zeros', async () => {
    const m = await computeMetrics(env, 'in_c', OPEN - 86400, OPEN + 86400);
    expect(m).toMatchObject({ calls: 0, answerRate: null, transferRate: null, recoveredBookings: 0, noShow: { status: 'not_tracked' } });
    expect(summaryText('X', m)).toMatch(/no calls/);
  });
  it('answer rate, transfer rate, recovered bookings by exact formulas', async () => {
    await savePilotConfig(env, 'in_c', { enabled: false, startsOn: null, endsOn: null, clinicNumber: null, clinicLine: null });
    await call('a', OPEN, { caller: 'h1' });                       // answered, booked, in hours, not overflow → booking from call, not recovered
    await booking('o1', 'h1', OPEN + 60);
    await call('b', OPEN + 600, { caller: 'h2' });                  // overflow (carrier forwarded) + booking → recovered
    await recordCallRouting(env, { carrier: 'plivo', callSid: 'b', businessType: 'in_c', forwardedFrom: '+918041234567' });
    await env.DB.prepare('UPDATE call_routing SET created_at = ? WHERE call_sid = ?').bind(OPEN + 600, 'b').run();
    await booking('o2', 'h2', OPEN + 600 + 100);
    await call('c', CLOSED, { caller: 'h3' });                      // after hours + booking 5 min after end → recovered
    await booking('o3', 'h3', CLOSED + 120 + 300);
    await call('d', CLOSED + 60, { userTurns: 0 });                 // silent: not answered
    await call('e', OPEN + 900, { transferred: true, caller: 'h5' });
    await booking('o5', 'h5', OPEN + 900 + 3600);                    // too late: not attributed
    await call('f', OPEN + 950, { caller: 'h6' });
    await booking('o6', 'h6', OPEN + 960, 'CANCELLED');              // cancelled: not counted
    await call('t', OPEN, { isTest: true, caller: 'synthetic-x' });   // excluded
    const m = await computeMetrics(env, 'in_c', OPEN - 3600, CLOSED + 3600);
    expect(m).toMatchObject({
      calls: 6, answered: 5, answerRate: 0.833, transfers: 1, transferRate: 0.2,
      overflowCalls: 1, afterHoursCalls: 2, bookingsFromCalls: 3, recoveredBookings: 2,
    });
  });
});

describe('weekly summary and share link (off by default)', () => {
  it('weekStart is Monday 00:00 IST', () => {
    const w = weekStart(new Date(OPEN * 1000), 'Asia/Kolkata');
    expect(w.date).toBe('2026-11-16');
    expect(new Date(w.unix * 1000).toISOString()).toBe('2026-11-15T18:30:00.000Z');
  });
  it('sends nothing unless turned on; then once per week', async () => {
    expect(await runWeeklySummaries(env, new Date('2026-11-23T03:00:00Z'))).toEqual([]);
    await saveMetricsSettings(env, 'in_c', { weeklySummary: true });
    await call('w1', OPEN);
    expect(await runWeeklySummaries(env, new Date('2026-11-23T03:00:00Z'))).toEqual([{ businessType: 'in_c', sent: true }]);
    expect(emails[0]).toMatchObject({ to: 'owner@c.in' });
    expect(emails[0].text).toMatch(/handled 1 call/);
    expect(await runWeeklySummaries(env, new Date('2026-11-24T03:00:00Z'))).toEqual([]);
  });
  it('report link: 404 until shared; a new token after off/on', async () => {
    const H = { 'X-Admin-Key': 'admin', 'Content-Type': 'application/json' };
    const on: any = await (await metricsRouter.request('/in_c/settings', { method: 'PUT', headers: H, body: JSON.stringify({ shareEnabled: true }) }, env)).json();
    const t1 = on.data.shareToken;
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
    const page = await publicReportRouter.request(`/${t1}`, {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/No calls have reached/);
    await metricsRouter.request('/in_c/settings', { method: 'PUT', headers: H, body: JSON.stringify({ shareEnabled: false }) }, env);
    expect((await publicReportRouter.request(`/${t1}`, {}, env)).status).toBe(404);
    const again: any = await (await metricsRouter.request('/in_c/settings', { method: 'PUT', headers: H, body: JSON.stringify({ shareEnabled: true }) }, env)).json();
    expect(again.data.shareToken).not.toBe(t1);
    expect((await metricsRouter.request('/in_c', {}, env)).status).toBe(401);
  });
});
