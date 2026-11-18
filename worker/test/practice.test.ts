import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import {
  getPracticeSettings, icsBusy, orderForToken, parseIcs, requestFrontDeskConfirmation, savePracticeSettings,
  suggestByFrontDesk, syncIcs, validatePracticeInput,
} from '../src/services/practice';
import { getCalendarBusy, isSlotFreeInCalendar } from '../src/services/calendar';
import { frontDeskRouter, practiceRouter } from '../src/routes/practice';

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:1', 'DTSTART:20301110T043000Z', 'DTEND:20301110T053000Z', 'SUMMARY:Root canal', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:2', 'DTSTART;TZID=Asia/Kolkata:20301110T150000', 'DURATION:PT45M', 'SUMMARY:Cleaning – patient with a very long', ' folded name', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:3', 'DTSTART;VALUE=DATE:20301111', 'SUMMARY:Clinic closed', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:4', 'DTSTART:20301110T060000Z', 'DTEND:20301110T070000Z', 'STATUS:CANCELLED', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:5', 'DTSTART:20301110T080000Z', 'DTEND:20301110T090000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:6', 'DTSTART:20200101T080000Z', 'DTEND:20200101T090000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

let env: Env;
let sms: Array<{ to: string; body: string }>;
let emails: string[];
beforeEach(async () => {
  env = {
    DB: createD1() as any, CACHE: createKV() as any, NODE_ENV: 'development', ADMIN_SECRET: 'admin', WORKER_URL: 'https://w.example',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550000000', RESEND_API_KEY: 're', EMAIL_FROM: 'a@b.c',
  } as Env;
  sms = []; emails = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = String(u);
    if (url.includes('twilio')) { const p = new URLSearchParams(String(init.body)); sms.push({ to: p.get('To')!, body: p.get('Body')! }); return Response.json({ sid: 'SM' }); }
    if (url.includes('resend')) { emails.push(JSON.parse(String(init.body)).subject); return Response.json({ id: 'e' }); }
    if (url === 'https://ics.example/feed.ics') return new Response(ICS, { headers: { 'content-type': 'text/calendar' } });
    if (url === 'https://ics.example/html') return new Response('<html></html>');
    return new Response('nf', { status: 404 });
  }));
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, notify_email, created_at, updated_at) VALUES ('in_p', 'Smile Dental', 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 'IN', 'desk@smile.in', 0, 0)`).run();
  await env.DB.prepare(`INSERT INTO vendors (id, name, business_type, contact_email, created_at) VALUES ('v1', 'x', 'in_p', 'x@x', 0)`).run();
  await env.DB.prepare(`INSERT INTO products (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type, description, price_cents, original_price_cents, duration_minutes, created_at) VALUES ('clean', 'in_p', 'v1', 'x', 'Cleaning', 'c', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING', '', 50000, 50000, 30, 0)`).run();
  await env.DB.prepare(`INSERT INTO orders (id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status, price_cents, payment_method, scheduled_at, customer_name, callback_phone, created_at, updated_at) VALUES ('o1', 'h1', 'in_p', 'clean', 'x', 'Cleaning', 'PENDING', 50000, 'cash', '2030-01-10T10:00:00', 'Priya', '+919800000001', 0, 0)`).run();
});
afterEach(() => vi.unstubAllGlobals());

describe('ICS import', () => {
  const from = Date.parse('2030-11-09T00:00:00Z'), to = Date.parse('2030-11-20T00:00:00Z');
  it('reads UTC, TZID, DURATION and all-day events; skips cancelled, free and past ones', () => {
    const busy = parseIcs(ICS, 'Asia/Kolkata', from, to);
    expect(busy.map(b => [new Date(b.start).toISOString(), new Date(b.end).toISOString()])).toEqual([
      ['2030-11-10T04:30:00.000Z', '2030-11-10T05:30:00.000Z'],
      ['2030-11-10T09:30:00.000Z', '2030-11-10T10:15:00.000Z'],   // 15:00 IST + 45 min
      ['2030-11-10T18:30:00.000Z', '2030-11-11T18:30:00.000Z'],   // all day 11 Nov IST
    ]);
  });
  it('sync caches busy times; calendar busy and the booking re-check include them; off clears them', async () => {
    expect(validatePracticeInput({ icsUrl: 'http://insecure.example/x.ics' })).toMatch(/https/);
    expect(validatePracticeInput({ icsUrl: 'webcal://ics.example/feed.ics' })).toEqual({ icsUrl: 'https://ics.example/feed.ics' });
    await expect(savePracticeSettings(env, 'in_p', { icsImport: true })).rejects.toMatchObject({ status: 400 });
    await savePracticeSettings(env, 'in_p', { icsImport: true, icsUrl: 'https://ics.example/feed.ics' });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-11-09T00:00:00Z'));
    const r = await syncIcs(env, 'in_p');
    expect(r).toEqual({ ok: true, busy: 3 });
    expect((await getPracticeSettings(env, 'in_p'))?.icsBusyCount).toBe(3);
    expect((await getCalendarBusy(env, 'in_p'))?.length).toBe(3);
    expect(await isSlotFreeInCalendar(env, 'in_p', new Date('2030-11-10T05:00:00Z'), new Date('2030-11-10T05:30:00Z'))).toBe(false);
    expect(await isSlotFreeInCalendar(env, 'in_p', new Date('2030-11-10T06:00:00Z'), new Date('2030-11-10T06:30:00Z'))).toBe(true);
    vi.useRealTimers();
    await savePracticeSettings(env, 'in_p', { icsUrl: 'https://ics.example/html' });
    expect(await syncIcs(env, 'in_p')).toMatchObject({ ok: false, error: expect.stringMatching(/not an iCalendar/) });
    await savePracticeSettings(env, 'in_p', { icsImport: false });
    expect(await icsBusy(env, 'in_p')).toEqual([]);
  });
});

describe('front-desk confirmation', () => {
  it('needs the front desk phone; settings are off by default', async () => {
    const H = { 'X-Admin-Key': 'admin' };
    const got: any = await (await practiceRouter.request('/in_p', { headers: H }, env)).json();
    expect(got.data).toMatchObject({ confirmationMode: false, icsImport: false, icsUrlSet: false });
    await expect(savePracticeSettings(env, 'in_p', { confirmationMode: true })).rejects.toMatchObject({ status: 400 });
    expect(validatePracticeInput({ frontDeskPhone: '98450 12345' })).toEqual({ frontDeskPhone: '+919845012345' });
  });
  it('request → link to the front desk, "pending" to the patient; GET changes nothing; confirm; suggest', async () => {
    await savePracticeSettings(env, 'in_p', { confirmationMode: true, frontDeskPhone: '+919845012345', software: 'practo' });
    const sent = await requestFrontDeskConfirmation(env, { name: 'Smile Dental', notifyEmail: 'desk@smile.in' } as any,
      { id: 'o1', businessType: 'in_p', productName: 'Cleaning', scheduledAt: '2030-01-10T10:00:00', customerName: 'Priya', callbackPhone: '+919800000001' });
    expect(sent).toBe('sms+email');
    const desk = sms.find(s => s.to === '+919845012345')!;
    const token = /\/fd\/([0-9a-f]{48})/.exec(desk.body)![1];
    expect(desk.body).toContain('https://w.example/fd/');
    expect(sms.find(s => s.to === '+919800000001')?.body).toMatch(/pending until the clinic confirms/);
    expect(emails[0]).toMatch(/Please confirm/);
    const page = await frontDeskRouter.request(`/${token}`, {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Confirm 2030-01-10 at 10:00');
    expect((await orderForToken(env, token))?.status).toBe('PENDING');
    expect((await frontDeskRouter.request('/' + 'f'.repeat(48), {}, env)).status).toBe(404);
    const conf = await frontDeskRouter.request(`/${token}/confirm`, { method: 'POST' }, env);
    expect(conf.status).toBe(303);
    expect(await orderForToken(env, token)).toMatchObject({ status: 'CONFIRMED', front_desk_status: 'confirmed' });
    expect(sms.filter(s => s.to === '+919800000001').at(-1)?.body).toMatch(/you're booked for Cleaning/);
    // Suggest on a second request.
    await env.DB.prepare(`UPDATE orders SET front_desk_status = 'pending' WHERE id = 'o1'`).run();
    expect(await suggestByFrontDesk(env, null, token, 'nope')).toMatch(/date and time/);
    const s = await suggestByFrontDesk(env, { name: 'Smile Dental', timezone: 'Asia/Kolkata' } as any, token, '2030-01-11T11:30');
    expect(s).toMatchObject({ front_desk_status: 'suggested', suggested_at: '2030-01-11T11:30' });
    expect(sms.at(-1)?.body).toMatch(/suggest 2030-01-11 at 11:30/);
  });
});
