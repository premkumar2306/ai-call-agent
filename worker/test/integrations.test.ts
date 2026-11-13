import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { INTEGRATIONS, readiness, redact } from '../src/services/integrations';

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}
const db = { prepare: () => ({ first: async () => null, bind() { return this; }, all: async () => ({ results: [] }) }) };

const SECRETS = {
  ADMIN_SECRET: 'admin-secret-value-123',
  TOKEN_SECRET: 'token-secret-value-0123456789abcdef0123',
  CUSTOMER_HASH_SALT: 'salt-value-xyz',
  ANTHROPIC_API_KEY: 'sk-ant-SECRET-anthropic-key',
  DEEPGRAM_API_KEY: 'dg-SECRET-deepgram-key',
  RESEND_API_KEY: 're_SECRET_resend_key', EMAIL_FROM: 'Avery <a@example.com>',
  SARVAM_API_KEY: 'sv-SECRET-sarvam-key',
  GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-SECRET-client', CALENDAR_TOKEN_KEY: 'cal-SECRET-key-value',
};
const VALUES = Object.entries(SECRETS).filter(([k]) => k !== 'EMAIL_FROM' && k !== 'GOOGLE_CLIENT_ID').map(([, v]) => v);
const makeEnv = () => ({ DB: db, CACHE: kv(), CART: kv(), ...SECRETS }) as any;
const H = { 'X-Admin-Key': SECRETS.ADMIN_SECRET };

let logs: string[] = [];
let respond: (url: string, init?: RequestInit) => Response;
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  respond = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const noSecrets = (text: string) => VALUES.forEach(v => expect(text).not.toContain(v));

describe('integrations registry', () => {
  it('names every service once, with settings, a link and a check', () => {
    const ids = INTEGRATIONS.map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['anthropic', 'deepgram', 'cartesia', 'sarvam', 'twilio', 'exotel', 'plivo', 'resend', 'razorpay', 'whatsapp', 'google', 'cloudflare']) expect(ids).toContain(id);
    for (const i of INTEGRATIONS) { expect(i.settings.length).toBeGreaterThan(0); expect(i.getFrom).toBeTruthy(); expect(i.doc).toBeTruthy(); }
    expect(INTEGRATIONS.find(i => i.id === 'razorpay')!.settings.map(s => s.name)).toContain('BILLING_SUPPLIER_GSTIN');
  });

  it('redacts configured secrets and auth headers', () => {
    const env = makeEnv();
    expect(redact(env, `bad key ${SECRETS.DEEPGRAM_API_KEY} and Bearer abcdefghijkl123`)).toBe('bad key [redacted] and Bearer [redacted]');
  });

  it('readiness lists blockers: required services and a carrier', () => {
    const r = readiness([
      { id: 'anthropic', name: 'Anthropic', requirement: 'required', status: 'ok' },
      { id: 'resend', name: 'Resend', requirement: 'required', status: 'not_configured' },
      { id: 'twilio', name: 'Twilio', requirement: 'carrier', status: 'unchecked' },
      { id: 'plivo', name: 'Plivo', requirement: 'carrier', status: 'fail' },
    ]);
    expect(r.blockers.map(b => b.id)).toEqual(['resend', 'carrier']);
    expect(r.blockers[1].status).toBe('unchecked');
    expect(r.score).toBe(50);
    expect(r.ready).toBe(false);
  });
});

describe('GET /admin/integrations', () => {
  it('needs the admin key', async () => {
    expect((await app.request('/admin/integrations', {}, makeEnv())).status).toBe(401);
    expect((await app.request('/admin/integrations', { headers: { 'X-Admin-Key': 'wrong' } }, makeEnv())).status).toBe(401);
  });

  it('reports booleans per setting, never values', async () => {
    const res = await app.request('/admin/integrations', { headers: H }, makeEnv());
    const text = await res.text();
    noSecrets(text);
    const { data } = JSON.parse(text);
    const by = Object.fromEntries(data.integrations.map((i: any) => [i.id, i]));
    expect(by.anthropic.configured).toEqual({ ANTHROPIC_API_KEY: true, ANTHROPIC_MODEL: false, VOICE_MODEL: false });
    expect(by.anthropic.status).toBe('unchecked');
    expect(by.cartesia.status).toBe('not_configured');
    expect(by.cartesia.missing).toEqual(['CARTESIA_API_KEY']);
    expect(data.readiness.blockers.map((b: any) => b.id)).toContain('carrier');
  });
});

describe('POST /admin/integrations/:id/check', () => {
  it('runs a check and caches it for GET', async () => {
    const env = makeEnv();
    const res = await app.request('/admin/integrations/anthropic/check', { method: 'POST', headers: H }, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.ok).toBe(true);
    const calls = (fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls).toEqual(['https://api.anthropic.com/v1/models?limit=1']);
    const list = await (await app.request('/admin/integrations', { headers: H }, env)).json() as any;
    expect(list.data.integrations.find((i: any) => i.id === 'anthropic').status).toBe('ok');
  });

  it('a failing provider gives a short error with no secret, in the response or the logs', async () => {
    respond = (_url, init) => new Response(JSON.stringify({ err_msg: `Invalid credentials: ${(init?.headers as any).Authorization}` }), { status: 401 });
    const env = makeEnv();
    const res = await app.request('/admin/integrations/deepgram/check', { method: 'POST', headers: H }, env);
    const text = await res.text();
    noSecrets(text);
    noSecrets(logs.join('\n'));
    const { data } = JSON.parse(text);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/^HTTP 401: Invalid credentials: Token \[redacted\]$/);
    const list = await (await app.request('/admin/integrations', { headers: H }, env)).text();
    noSecrets(list);
    expect(JSON.parse(list).data.integrations.find((i: any) => i.id === 'deepgram').status).toBe('fail');
  });

  it('a network error or timeout is a failure, not a crash', async () => {
    respond = () => { throw new Error(`connect failed for ${SECRETS.RESEND_API_KEY}`); };
    const res = await app.request('/admin/integrations/resend/check', { method: 'POST', headers: H }, makeEnv());
    const text = await res.text();
    noSecrets(text);
    expect(JSON.parse(text).data).toMatchObject({ ok: false, error: 'connect failed for [redacted]' });
  });

  it('is rate limited per service', async () => {
    const env = makeEnv();
    expect((await app.request('/admin/integrations/anthropic/check', { method: 'POST', headers: H }, env)).status).toBe(200);
    const again = await app.request('/admin/integrations/anthropic/check', { method: 'POST', headers: H }, env);
    expect(again.status).toBe(429);
    expect((fetch as any).mock.calls.length).toBe(1);
  });

  it('accepts the read-only answers that prove a key works', async () => {
    const env = makeEnv();
    respond = () => new Response('{"error":{"message":"text is required"}}', { status: 400 });
    expect((await (await app.request('/admin/integrations/sarvam/check', { method: 'POST', headers: H }, env)).json() as any).data.ok).toBe(true);
    respond = () => new Response('{"name":"restricted_api_key"}', { status: 401 });
    expect((await (await app.request('/admin/integrations/resend/check', { method: 'POST', headers: H }, env)).json() as any).data.ok).toBe(true);
    respond = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    expect((await (await app.request('/admin/integrations/google/check', { method: 'POST', headers: H }, env)).json() as any).data.ok).toBe(true);
    respond = () => new Response('{"error":"invalid_client"}', { status: 401 });
    expect((await (await app.request('/admin/integrations/google/check', { method: 'POST', headers: H }, makeEnv())).json() as any).data).toMatchObject({ ok: false, error: 'HTTP 401: invalid_client' });
  });

  it('does not call out for a service that is not set up, and 404s unknown ids', async () => {
    const res = await app.request('/admin/integrations/razorpay/check', { method: 'POST', headers: H }, makeEnv());
    expect((await res.json() as any).data).toMatchObject({ ok: null, note: 'Not set up' });
    expect((fetch as any).mock.calls.length).toBe(0);
    expect((await app.request('/admin/integrations/nope/check', { method: 'POST', headers: H }, makeEnv())).status).toBe(404);
  });

  it('no check writes: every outside call is a GET, except the two documented probes', async () => {
    const env = { ...makeEnv(), TWILIO_AUTH_TOKEN: 'tw-SECRET', TWILIO_WEBHOOK_URL: 'https://w', TWILIO_ACCOUNT_SID: 'AC1', CARTESIA_API_KEY: 'ca-SECRET',
      RAZORPAY_KEY_ID: 'rzp', RAZORPAY_KEY_SECRET: 'rzp-SECRET', RAZORPAY_WEBHOOK_SECRET: 'rzpw-SECRET', WA_APP_SECRET: 'wa1-SECRET', WA_VERIFY_TOKEN: 'wa2-SECRET', WA_ACCESS_TOKEN: 'wa3-SECRET',
      PLIVO_AUTH_TOKEN: 'pl-SECRET', PLIVO_WEBHOOK_URL: 'https://w', PLIVO_AUTH_ID: 'MA1', EXOTEL_WEBHOOK_SECRET: 'ex-SECRET', EXOTEL_ACCOUNT_SID: 'x', EXOTEL_API_KEY: 'k', EXOTEL_API_TOKEN: 't' };
    for (const i of INTEGRATIONS) await app.request(`/admin/integrations/${i.id}/check`, { method: 'POST', headers: H }, env);
    const posts = (fetch as any).mock.calls.filter((c: any[]) => (c[1]?.method ?? 'GET') !== 'GET').map((c: any[]) => String(c[0]));
    expect(posts.sort()).toEqual(['https://api.sarvam.ai/text-to-speech', 'https://oauth2.googleapis.com/token']);
  });
});

describe('GET /features', () => {
  it('needs a sign-in, and says which optional features are set up', async () => {
    expect((await app.request('/features', {}, makeEnv())).status).toBe(401);
    const res = await app.request('/features', { headers: H }, makeEnv());
    expect((await res.json() as any).data).toEqual({ hindi: true, calendar: true, whatsapp: false, billing: false, sms: false, email: true });
  });
});
