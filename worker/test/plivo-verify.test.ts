import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { createTestD1, createTestKV } from './helpers/d1.mjs';
import { upsertPhoneNumber } from '../src/services/phone-numbers';
import { renderPlivoVerify, scrubAll } from '../scripts/plivo-verify-lib.mjs';

const SECRETS = { ADMIN_SECRET: 'admin-secret-value-123', PLIVO_AUTH_ID: 'MAPLIVOID0001', PLIVO_AUTH_TOKEN: 'plivo-SECRET-token-value' };
const W = 'https://avery.example.workers.dev';
const H = { 'X-Admin-Key': SECRETS.ADMIN_SECRET };
const ACC = `https://api.plivo.com/v1/Account/${SECRETS.PLIVO_AUTH_ID}`;

function makeEnv() {
  return { DB: createTestD1().d1, CACHE: createTestKV(), CART: createTestKV(), TOKEN_SECRET: 'x'.repeat(40), NODE_ENV: 'production', PLIVO_WEBHOOK_URL: W, ...SECRETS } as any;
}
let calls: { url: string; method: string; auth: string | null }[] = [];
let respond: (url: string) => Response;
beforeEach(() => {
  calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    return respond(url);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
function plivoApi(url: string): Response {
  if (url === `${ACC}/`) return json({ account_type: 'standard', auth_id: SECRETS.PLIVO_AUTH_ID });
  if (url.startsWith(`${ACC}/Number/`)) return json({ objects: [
    { number: '918047100001', voice_enabled: true, application: `/v1/Account/${SECRETS.PLIVO_AUTH_ID}/Application/111/` },
    { number: '918047100002', voice_enabled: true, application: `/v1/Account/${SECRETS.PLIVO_AUTH_ID}/Application/222/` },
    { number: '918047100003', voice_enabled: true, application: null },
  ] });
  if (url === `${ACC}/Application/111/`) return json({ app_name: 'Avery', answer_url: `${W}/plivo/answer`, answer_method: 'POST', hangup_url: `${W}/plivo/hangup` });
  if (url === `${ACC}/Application/222/`) return json({ app_name: 'Old', answer_url: 'https://old.example.com/answer', answer_method: 'GET', hangup_url: '' });
  return json({ error: 'not found' }, 404);
}

describe('GET /admin/plivo/verify', () => {
  it('needs the admin key', async () => {
    respond = plivoApi;
    expect((await app.request('/admin/plivo/verify', {}, makeEnv())).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('reports numbers, their answer URLs and business mapping — read-only, no secret in the response', async () => {
    respond = plivoApi;
    const env = makeEnv();
    await upsertPhoneNumber(env, { number: '+918047100001', provider: 'plivo', businessType: 'in_clinic', label: null });
    const res = await app.request('/admin/plivo/verify', { headers: H }, env);
    const text = await res.text();
    expect(res.status).toBe(200);
    const d = JSON.parse(text).data;
    expect(d.account.ok).toBe(true);
    expect(d.expected.answerUrl).toBe(`${W}/plivo/answer`);
    const [a, b, c] = d.numbers;
    expect(a).toMatchObject({ number: '+918047100001', businessType: 'in_clinic', answerOk: true, hangupOk: true });
    expect(b).toMatchObject({ number: '+918047100002', businessType: null, answerOk: false, application: { answerUrl: 'https://old.example.com/answer' } });
    expect(c).toMatchObject({ number: '+918047100003', application: null, answerOk: false });
    for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
    expect(calls.every(x => x.method === 'GET' && x.url.startsWith('https://api.plivo.com/'))).toBe(true);
  });

  it('a 401 from Plivo is Failing with a redacted error, and numbers are not listed', async () => {
    respond = () => json({ error: `bad credentials Basic ${btoa(`${SECRETS.PLIVO_AUTH_ID}:${SECRETS.PLIVO_AUTH_TOKEN}`)} ${SECRETS.PLIVO_AUTH_TOKEN}` }, 401);
    const res = await app.request('/admin/plivo/verify', { headers: H }, makeEnv());
    const text = await res.text();
    const d = JSON.parse(text).data;
    expect(d.account.ok).toBe(false);
    expect(d.account.error).toMatch(/^HTTP 401/);
    expect(d.numbers).toEqual([]);
    expect(calls).toHaveLength(1);
    for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
  });

  it('is rate limited', async () => {
    respond = plivoApi;
    const env = makeEnv();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await app.request('/admin/plivo/verify', { headers: H }, env)).status;
    expect(last).toBe(429);
  });
});

describe('plivo:verify checklist', () => {
  const report = {
    settings: { PLIVO_AUTH_ID: true, PLIVO_AUTH_TOKEN: true, PLIVO_WEBHOOK_URL: true, PLIVO_DEFAULT_BUSINESS_TYPE: false },
    account: { ok: true }, expected: { answerUrl: `${W}/plivo/answer`, hangupUrl: `${W}/plivo/hangup` },
    numbers: [
      { number: '+918047100001', voiceEnabled: true, businessType: 'in_clinic', reachesDefault: false, application: { id: '111', name: 'Avery', answerUrl: `${W}/plivo/answer`, answerMethod: 'POST', hangupUrl: `${W}/plivo/hangup` }, answerOk: true, hangupOk: true },
    ],
  };
  it('all ✓ when set up', () => {
    const r = renderPlivoVerify({ workerUrl: W, health: { ok: true, status: 200 }, unsigned: { status: 403 }, report });
    expect(r.ok).toBe(true);
    expect(r.lines.some(l => l.startsWith('✗'))).toBe(false);
    expect(r.next[0]).toMatch(/live test calls/);
  });
  it('gives the exact fix for a wrong answer URL, an unmapped number and an accepted unsigned webhook', () => {
    const bad = { ...report, numbers: [{ ...report.numbers[0], businessType: null, answerOk: false, application: { ...report.numbers[0].application, answerUrl: 'https://old/answer' } }] };
    const r = renderPlivoVerify({ workerUrl: W, health: { ok: true, status: 200 }, unsigned: { status: 200 }, report: bad });
    expect(r.ok).toBe(false);
    expect(r.next.join('\n')).toContain(`Answer URL = ${W}/plivo/answer, method POST`);
    expect(r.next.join('\n')).toContain('Settings → Phone numbers: add +918047100001, provider Plivo');
    expect(r.next.join('\n')).toMatch(/unsigned Plivo webhook/);
  });
  it('tells the owner which secret to set when Plivo refuses the keys', () => {
    const r = renderPlivoVerify({ workerUrl: W, health: { ok: true, status: 200 }, unsigned: { status: 403 }, report: { ...report, account: { ok: false, error: 'HTTP 401: bad' }, numbers: [] } });
    expect(r.ok).toBe(false);
    expect(r.next.join('\n')).toContain('npx wrangler secret put PLIVO_AUTH_TOKEN');
  });
  it('scrubs a value', () => expect(scrubAll('key abcdef123 here', ['abcdef123'])).toBe('key [redacted] here'));
});
