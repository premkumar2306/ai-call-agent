import { beforeEach, describe, expect, it } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import {
  classifyCall, forwardedFromParam, forwardingTestResult, getPilotConfig, pilotActive, recentRoutes, recordCallRouting,
  savePilotConfig, startForwardingTest, validatePilotInput,
} from '../src/services/pilot';
import { pilotRouter } from '../src/routes/pilot';

let env: Env;
beforeEach(async () => {
  env = { DB: createD1() as any, CACHE: createKV() as any, NODE_ENV: 'development', ADMIN_SECRET: 'admin', TOKEN_SECRET: 'x'.repeat(32) } as Env;
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, created_at, updated_at) VALUES ('in_clinic', 'Clinic', 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 'IN', 0, 0)`).run();
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, created_at, updated_at) VALUES ('us_biz', 'US', 'service', '[]', '{}', 0, 0)`).run();
});

describe('pilot rules', () => {
  const cfg = { enabled: true, mode: 'overflow', startsOn: '2026-11-20', endsOn: '2026-12-19' };
  it('is active only between the dates, inclusive, in the business time zone', () => {
    expect(pilotActive(cfg, new Date('2026-11-19T18:29:00Z'))).toBe(false); // 23:59 IST 19 Nov
    expect(pilotActive(cfg, new Date('2026-11-19T18:31:00Z'))).toBe(true);  // 00:01 IST 20 Nov
    expect(pilotActive(cfg, new Date('2026-12-19T18:29:00Z'))).toBe(true);
    expect(pilotActive(cfg, new Date('2026-12-19T18:31:00Z'))).toBe(false);
    expect(pilotActive({ ...cfg, enabled: false }, new Date('2026-11-25T06:00:00Z'))).toBe(false);
    expect(pilotActive(null, new Date())).toBe(false);
  });
  it('classifies: carrier-forwarded, pilot overflow, direct', () => {
    expect(classifyCall('+918041234567', false)).toEqual({ isOverflow: true, reason: 'carrier_forwarded', pilotActive: false });
    expect(classifyCall(null, true)).toEqual({ isOverflow: true, reason: 'pilot_overflow', pilotActive: true });
    expect(classifyCall(null, false)).toEqual({ isOverflow: false, reason: 'direct', pilotActive: false });
  });
  it('reads ForwardedFrom (Plivo/Twilio; Exotel only if present)', () => {
    expect(forwardedFromParam({ ForwardedFrom: '918041234567' })).toBe('+918041234567');
    expect(forwardedFromParam({ ForwardedFrom: '+14155550100' }, '1')).toBe('+14155550100');
    expect(forwardedFromParam({ From: '+919876543210' })).toBeNull();
    expect(forwardedFromParam({ ForwardedFrom: '' })).toBeNull();
  });
  it('validates input: dates, order, number', () => {
    expect(validatePilotInput({ enabled: true })).toMatch(/start and an end/);
    expect(validatePilotInput({ enabled: true, startsOn: '2026-12-01', endsOn: '2026-11-01' })).toMatch(/before/);
    expect(validatePilotInput({ startsOn: '1/12/2026' })).toMatch(/YYYY-MM-DD/);
    expect(validatePilotInput({ clinicNumber: 'abc' })).toMatch(/phone number/);
    expect(validatePilotInput({ enabled: true, startsOn: '2026-11-20', endsOn: '2026-12-19', clinicNumber: '080 4123 4567', clinicLine: 'jio' }))
      .toEqual({ enabled: true, startsOn: '2026-11-20', endsOn: '2026-12-19', clinicNumber: '+918041234567', clinicLine: 'jio' });
  });
});

describe('call routing records', () => {
  it('writes nothing for a business without a pilot unless the carrier says forwarded (US unchanged)', async () => {
    await recordCallRouting(env, { carrier: 'twilio', callSid: 'CA1', businessType: 'us_biz' });
    expect(await recentRoutes(env, 'us_biz')).toHaveLength(0);
    await recordCallRouting(env, { carrier: 'plivo', callSid: 'p1', businessType: 'in_clinic', forwardedFrom: '+918041234567' });
    expect((await recentRoutes(env, 'in_clinic'))[0]).toMatchObject({ isOverflow: true, reason: 'carrier_forwarded', forwardedFrom: '+918041234567' });
  });
  it('tags every call as overflow during an active pilot; idempotent per call', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    await savePilotConfig(env, 'in_clinic', { enabled: true, startsOn: today, endsOn: '2099-01-01', clinicNumber: '+918041234567', clinicLine: 'airtel' });
    await recordCallRouting(env, { carrier: 'exotel', callSid: 'e1', businessType: 'in_clinic' });
    await recordCallRouting(env, { carrier: 'exotel', callSid: 'e1', businessType: 'in_clinic' });
    const rows = await recentRoutes(env, 'in_clinic');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isOverflow: true, reason: 'pilot_overflow', pilotActive: true });
  });
  it('forwarding test: waiting → received, with the clinic number matched', async () => {
    await savePilotConfig(env, 'in_clinic', { enabled: false, startsOn: null, endsOn: null, clinicNumber: '+918041234567', clinicLine: 'jio' });
    expect((await forwardingTestResult(env, 'in_clinic')).status).toBe('not_started');
    const started = await startForwardingTest(env, 'in_clinic');
    expect((await forwardingTestResult(env, 'in_clinic')).status).toBe('waiting');
    expect((await forwardingTestResult(env, 'in_clinic', started + 16 * 60)).status).toBe('expired');
    await recordCallRouting(env, { carrier: 'plivo', callSid: 'p9', businessType: 'in_clinic', forwardedFrom: '+918041234567' });
    const r = await forwardingTestResult(env, 'in_clinic');
    expect(r.status).toBe('received');
    expect(r.call).toMatchObject({ forwardedFromMatches: true, reason: 'carrier_forwarded' });
  });
});

describe('/pilot routes', () => {
  const H = { 'X-Admin-Key': 'admin', 'Content-Type': 'application/json' };
  it('needs a login; saves and reads the pilot', async () => {
    expect((await pilotRouter.request('/in_clinic', {}, env)).status).toBe(401);
    const put = await pilotRouter.request('/in_clinic', { method: 'PUT', headers: H, body: JSON.stringify({ enabled: true, startsOn: '2026-11-20', endsOn: '2026-12-19', clinicNumber: '+918041234567' }) }, env);
    expect(put.status).toBe(200);
    expect((await getPilotConfig(env, 'in_clinic'))?.enabled).toBe(true);
    const got: any = await (await pilotRouter.request('/in_clinic', { headers: H }, env)).json();
    expect(got.data.config).toMatchObject({ startsOn: '2026-11-20', clinicNumber: '+918041234567' });
    const bad = await pilotRouter.request('/in_clinic', { method: 'PUT', headers: H, body: JSON.stringify({ enabled: true }) }, env);
    expect(bad.status).toBe(400);
  });
});
