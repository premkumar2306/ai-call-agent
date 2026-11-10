import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { app } from '../src/index';
import {
  LOGIN_CODE_MAX_ATTEMPTS, consumeLoginCode, emailIdentifier, generateLoginCode, isValidHoursRange,
  issueLoginCode, normalizeEmail, normalizePhoneE164, parseBusinessInput, parseBusinessPatch, roleAllows, slugify,
} from '../src/services/accounts';
import { signStreamToken } from '../src/utils/stream-token';
import { createD1, createKV, executionCtx } from './stubs/d1';
import type { Env } from '../src/types';

const ADMIN = 'admin-secret-for-tests-0123456789';
const TOKEN_SECRET = 't'.repeat(40);

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('account validators', () => {
  it('normalizes emails and rejects junk', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', 42, null, `${'x'.repeat(250)}@example.com`]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
  it('accepts E.164 phones with separators only', () => {
    expect(normalizePhoneE164('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhoneE164('+1 (312) 685-4305')).toBe('+13126854305');
    expect(normalizePhoneE164('9876543210')).toBeNull();
    expect(normalizePhoneE164('+0123456789')).toBeNull();
  });
  it('generates uniform 6-digit codes', () => {
    for (let i = 0; i < 200; i++) expect(generateLoginCode()).toMatch(/^\d{6}$/);
    expect(new Set(Array.from({ length: 50 }, generateLoginCode)).size).toBeGreaterThan(45);
  });
  it('validates opening hours', () => {
    expect(isValidHoursRange('9am–6pm')).toBe(true);
    expect(isValidHoursRange('7:30am-12pm')).toBe(true);
    expect(isValidHoursRange('6pm–9am')).toBe(false);
    expect(isValidHoursRange('9–5')).toBe(false);
    expect(isValidHoursRange('13pm–14pm')).toBe(false);
  });
  it('slugifies business names', () => {
    expect(slugify('Dr. Mehta’s Skin & Hair Clinic, Pune')).toBe('dr_mehta_s_skin_hair_cli');
    expect(slugify('Café Crème')).toBe('cafe_creme');
    expect(slugify('!!!')).toBe('business');
  });
  it('orders roles', () => {
    expect(roleAllows('owner', 'staff')).toBe(true);
    expect(roleAllows('staff', 'staff')).toBe(true);
    expect(roleAllows('staff', 'owner')).toBe(false);
    expect(roleAllows(null, 'staff')).toBe(false);
  });
});

const wizardBody = (over: Record<string, unknown> = {}) => ({
  name: 'Sharma Dental Care', kind: 'dental', address: '12 MG Road, Bengaluru', phone: '+91 98765 43210',
  timezone: 'Asia/Kolkata', currency: 'INR',
  hours: { mon: '9am–6pm', tue: '9am–6pm', wed: '9am–6pm', thu: '9am–6pm', fri: '9am–6pm', sat: '10am–2pm' },
  services: [
    { name: 'Consultation', priceCents: 50000, durationMinutes: 20 },
    { name: 'Scaling & polishing', priceCents: 150000, durationMinutes: 45, description: 'Cleaning' },
  ],
  ...over,
});

describe('parseBusinessInput', () => {
  it('accepts a complete wizard payload', () => {
    const r = parseBusinessInput(wizardBody());
    expect(typeof r).toBe('object');
    if (typeof r === 'object') {
      expect(r.phone).toBe('+919876543210');
      expect(r.hours.sun).toBeUndefined();
      expect(r.services).toHaveLength(2);
    }
  });
  it.each([
    [{ name: 'x' }, /name/],
    [{ kind: 'casino' }, /type/],
    [{ timezone: 'Mars/Olympus' }, /time zone/],
    [{ currency: 'rupees' }, /currency/],
    [{ hours: {} }, /at least one day/],
    [{ hours: { mon: 'all day' } }, /mon/],
    [{ phone: '98765' }, /country code/],
    [{ services: [] }, /at least one service/],
    [{ services: [{ name: 'X', priceCents: 1.5, durationMinutes: 30 }] }, /Price/],
    [{ services: [{ name: 'X', priceCents: 100, durationMinutes: 1 }] }, /Duration/],
  ])('rejects %j', (over, msg) => {
    const r = parseBusinessInput(wizardBody(over));
    expect(typeof r).toBe('string');
    expect(r).toMatch(msg);
  });
  it('patch only touches what was sent, and clears optional fields with ""', () => {
    expect(parseBusinessPatch({ phone: '', about: 'Parking at the back' })).toEqual({ phone: null, about: 'Parking at the back' });
    expect(parseBusinessPatch({})).toBe('Nothing to update');
    expect(parseBusinessPatch({ hours: { mon: 'nope' } })).toMatch(/mon/);
  });
});

// ── Routes against an in-memory D1 ─────────────────────────────────────────

let env: Env;
let sentEmails: { to: string; subject: string; text: string }[];

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: createD1() as unknown as D1Database,
    CACHE: createKV() as unknown as KVNamespace,
    CART: createKV() as unknown as KVNamespace,
    TOKEN_SECRET, ADMIN_SECRET: ADMIN, NODE_ENV: 'production', RESEND_API_KEY: 're_test',
    CUSTOMER_HASH_SALT: 'salt',
    ...over,
  } as Env;
}

beforeEach(() => {
  env = makeEnv();
  sentEmails = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const body = JSON.parse(String(init.body));
      sentEmails.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response('{"id":"x"}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

let ipCounter = 0;
function req(path: string, init: { method?: string; body?: unknown; token?: string; admin?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': init.ip ?? `10.0.0.${++ipCounter % 250}` };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.admin !== undefined) headers['x-admin-key'] = init.admin;
  return app.request(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }, env, executionCtx as any);
}

const lastCode = () => sentEmails.at(-1)!.subject.slice(0, 6);

async function signIn(email: string): Promise<string> {
  expect((await req('/account/login/start', { body: { email } })).status).toBe(200);
  const res = await req('/account/login/verify', { body: { email, code: lastCode() } });
  expect(res.status).toBe(200);
  return (await res.json() as any).data.token;
}

async function createBiz(token: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await req('/account/businesses', { token, body: wizardBody(over) });
  expect(res.status).toBe(201);
  return (await res.json() as any).data.key;
}

describe('email code sign-in', () => {
  it('signs up on first verify and returns the same response for new and known addresses', async () => {
    await signIn('known@example.com');
    const a = await req('/account/login/start', { body: { email: 'known@example.com' } });
    const b = await req('/account/login/start', { body: { email: 'new@example.com' } });
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
    expect(sentEmails.map(e => e.to)).toEqual(['known@example.com', 'known@example.com', 'new@example.com']);
    // Production never hands the code back in the response.
    expect(JSON.stringify(await (await req('/account/login/start', { body: { email: 'x@example.com' } })).json())).not.toMatch(/devCode/);
  });

  it('rejects a wrong code with a generic error and burns the code after too many attempts', async () => {
    await req('/account/login/start', { body: { email: 'o@example.com' } });
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS; i++) {
      const r = await req('/account/login/verify', { body: { email: 'o@example.com', code: wrong } });
      expect(r.status).toBe(401);
      expect((await r.json() as any).error).toBe('That code is wrong or has expired');
    }
    const r = await req('/account/login/verify', { body: { email: 'o@example.com', code } });
    expect(r.status).toBe(401);
  });

  it('gives the same error for an address that never asked for a code', async () => {
    const r = await req('/account/login/verify', { body: { email: 'nobody@example.com', code: '123456' } });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toBe('That code is wrong or has expired');
  });

  it('codes are single-use and expire', async () => {
    const id = emailIdentifier('t@example.com');
    const code = await issueLoginCode(env, id);
    expect(await consumeLoginCode(env, id, code)).toBe(true);
    expect(await consumeLoginCode(env, id, code)).toBe(false);
    const code2 = await issueLoginCode(env, id);
    expect(await consumeLoginCode(env, id, code2, new Date(Date.now() + 11 * 60_000))).toBe(false);
  });

  it('a new code replaces the previous one', async () => {
    const id = emailIdentifier('r@example.com');
    const first = await issueLoginCode(env, id);
    const second = await issueLoginCode(env, id);
    if (first !== second) expect(await consumeLoginCode(env, id, first)).toBe(false);
    expect(await consumeLoginCode(env, id, second)).toBe(true);
  });

  it('rate-limits codes per address', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await req('/account/login/start', { body: { email: 'flood@example.com' } })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('rate-limits code sends per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await req('/account/login/start', { body: { email: `u${i}@example.com` }, ip: '9.9.9.9' })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('fails closed in production without RESEND_API_KEY, and hands the code back in development', async () => {
    env = makeEnv({ RESEND_API_KEY: undefined });
    expect((await req('/account/login/start', { body: { email: 'a@example.com' } })).status).toBe(503);
    env = makeEnv({ RESEND_API_KEY: undefined, NODE_ENV: 'development' });
    const r = await req('/account/login/start', { body: { email: 'a@example.com' } });
    const code = (await r.json() as any).data.devCode;
    expect(code).toMatch(/^\d{6}$/);
    expect((await req('/account/login/verify', { body: { email: 'a@example.com', code } })).status).toBe(200);
  });
});

describe('owner sessions', () => {
  it('/account/me needs a valid owner token', async () => {
    const token = await signIn('me@example.com');
    const me = await req('/account/me', { token });
    expect(me.status).toBe(200);
    expect((await me.json() as any).data.user.email).toBe('me@example.com');

    expect((await req('/account/me')).status).toBe(401);
    expect((await req('/account/me', { token: token.slice(0, -2) + 'xx' })).status).toBe(401);
    // A caller session or media-stream token is not an owner token.
    const caller = await new SignJWT({ sub: 'x', businessType: 'auto_shop' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(TOKEN_SECRET));
    expect((await req('/account/me', { token: caller })).status).toBe(401);
    expect((await req('/account/me', { token: await signStreamToken(env, 'auto_shop') })).status).toBe(401);
    // Even with the right audience, a token signed with TOKEN_SECRET itself is rejected (separate key).
    const forged = await new SignJWT({ sv: 1 }).setProtectedHeader({ alg: 'HS256' }).setSubject('x')
      .setAudience('avery-owner').setExpirationTime('1h').sign(new TextEncoder().encode(TOKEN_SECRET));
    expect((await req('/account/me', { token: forged })).status).toBe(401);
  });

  it('logout revokes the token', async () => {
    const token = await signIn('bye@example.com');
    expect((await req('/account/logout', { token, method: 'POST' })).status).toBe(200);
    expect((await req('/account/me', { token })).status).toBe(401);
    const again = await signIn('bye@example.com');
    expect((await req('/account/me', { token: again })).status).toBe(200);
  });

  it('an owner token cannot be used as a caller session', async () => {
    const token = await signIn('c@example.com');
    const r = await req('/catalog', { token });
    expect(r.status).toBe(401);
  });
});

describe('onboarding', () => {
  it('creates the sector, services and owner membership', async () => {
    const token = await signIn('dentist@example.com');
    const key = await createBiz(token);
    expect(key).toMatch(/^sharma_dental_care_[a-z0-9]{4}$/);

    const me = await (await req('/account/me', { token })).json() as any;
    expect(me.data.businesses).toEqual([{ key, name: 'Sharma Dental Care', kind: 'dental', role: 'owner' }]);

    const sector = await (await req(`/admin/sectors/${key}`, { token })).json() as any;
    expect(sector.data).toMatchObject({ timezone: 'Asia/Kolkata', currency: 'INR', phone: '+919876543210', notifyEmail: 'dentist@example.com', kind: 'dental' });
    const prods = await (await req(`/admin/products/${key}`, { token })).json() as any;
    expect(prods.data.map((p: any) => [p.name, p.priceCents, p.durationMinutes])).toEqual([
      ['Consultation', 50000, 20], ['Scaling & polishing', 150000, 45],
    ]);
    // Publicly visible to the voice-test page like every other business.
    const pub = await (await req('/sectors')).json() as any;
    expect(pub.data.some((s: any) => s.key === key)).toBe(true);
  });

  it('two businesses with the same name get different keys', async () => {
    const token = await signIn('chain@example.com');
    const a = await createBiz(token);
    const b = await createBiz(token);
    expect(a).not.toBe(b);
  });

  it('rejects bad input and anonymous callers', async () => {
    const token = await signIn('bad@example.com');
    expect((await req('/account/businesses', { token, body: wizardBody({ services: [] }) })).status).toBe(400);
    expect((await req('/account/businesses', { body: wizardBody() })).status).toBe(401);
    expect((await req('/account/businesses', { admin: ADMIN, body: wizardBody() })).status).toBe(401);
  });
});

describe('cross-tenant access is denied', () => {
  let tokenA: string, tokenB: string, keyA: string, keyB: string, productA: string;

  beforeEach(async () => {
    tokenA = await signIn('a@clinic.example');
    tokenB = await signIn('b@salon.example');
    keyA = await createBiz(tokenA);
    keyB = await createBiz(tokenB, { name: 'Glow Salon', kind: 'salon' });
    productA = ((await (await req(`/admin/products/${keyA}`, { token: tokenA })).json()) as any).data[0].id;
    const sqlite = (env.DB as any).sqlite;
    sqlite.prepare(`INSERT INTO call_messages (id, business_type, message, status, created_at) VALUES ('m1', ?, 'call me', 'NEW', 0)`).run(keyA);
  });

  const readRoutes = (k: string) => [
    `/admin/sectors/${k}`, `/admin/config/${k}`, `/admin/products/${k}`, `/admin/transcripts/${k}`,
    `/admin/bookings/${k}`, `/admin/messages/${k}`, `/admin/calendar/${k}`, `/account/businesses/${k}/members`,
  ];

  it('owner A reads their own business', async () => {
    for (const path of readRoutes(keyA).filter(p => !p.includes('/calendar/') && !p.includes('/members'))) {
      expect([path, (await req(path, { token: tokenA })).status]).toEqual([path, 200]);
    }
    expect((await req(`/account/businesses/${keyA}/members`, { token: tokenA })).status).toBe(200);
  });

  it("other PRs' business routes (privacy, voice, doctors, billing) follow the same rule", async () => {
    const routes = (k: string) => [
      `/admin/privacy/${k}/settings`, `/admin/privacy/${k}/requests`,
      `/admin/sectors/${k}/voice`, `/admin/resources/${k}`, `/billing/${k}`,
    ];
    for (const path of routes(keyA)) {
      expect([path, (await req(path, { token: tokenA })).status]).toEqual([path, 200]);
      // Billing answers 401 rather than 403 so it doesn't reveal which businesses exist.
      expect([path, (await req(path, { token: tokenB })).status]).toEqual([path, path.startsWith('/billing') ? 401 : 403]);
      expect([path, (await req(path)).status]).toEqual([path, 401]);
      expect([path, (await req(path, { admin: ADMIN })).status]).toEqual([path, 200]);
    }
    // An owner sees their billing but never the operator's cost and margin.
    const bill = await (await req(`/billing/${keyA}`, { token: tokenA })).json() as any;
    expect(bill.data.cost ?? null).toBeNull();
    expect((await req(`/admin/billing/plans`, { token: tokenA })).status).toBe(401);
    expect((await req(`/admin/privacy/${keyA}/erase`, { token: tokenB, body: { phone: '+919876543210' } })).status).toBe(403);
  });

  it("owner B gets 403 on every one of A's routes", async () => {
    for (const path of readRoutes(keyA)) {
      expect([path, (await req(path, { token: tokenB })).status]).toEqual([path, 403]);
    }
    const writes: [string, string, unknown][] = [
      ['PUT', `/admin/sectors/${keyA}`, { name: 'Hijacked' }],
      ['PUT', `/admin/config/${keyA}`, { greeting: 'pwned' }],
      ['POST', `/admin/products/${keyA}`, { name: 'X', priceCents: 1, durationMinutes: 30 }],
      ['PUT', `/admin/products/${keyA}/${productA}`, { priceCents: 1 }],
      ['DELETE', `/admin/products/${keyA}/${productA}`, undefined],
      ['PATCH', `/admin/messages/${keyA}/m1`, { status: 'DONE' }],
      ['POST', `/admin/calendar/${keyA}/google/connect`, { returnTo: 'http://localhost:5173/' }],
      ['DELETE', `/admin/calendar/${keyA}`, undefined],
      ['POST', `/account/businesses/${keyA}/members`, { email: 'b@salon.example', role: 'owner' }],
    ];
    for (const [method, path, body] of writes) {
      expect([method, path, (await req(path, { method, token: tokenB, body })).status]).toEqual([method, path, 403]);
    }
    const sector = await (await req(`/admin/sectors/${keyA}`, { token: tokenA })).json() as any;
    expect(sector.data.name).toBe('Sharma Dental Care');
  });

  it("B can't reach A's service through B's own business path", async () => {
    for (const method of ['PUT', 'DELETE']) {
      const r = await req(`/admin/products/${keyB}/${productA}`, { method, token: tokenB, body: method === 'PUT' ? { priceCents: 1 } : undefined });
      expect(r.status).toBe(404);
    }
    const p = ((await (await req(`/admin/products/${keyA}`, { token: tokenA })).json()) as any).data.find((x: any) => x.id === productA);
    expect(p).toMatchObject({ priceCents: 50000, isActive: true });
    // …nor A's message through B's path.
    await req(`/admin/messages/${keyB}/m1`, { method: 'PATCH', token: tokenB, body: { status: 'DONE' } });
    const msgs = ((await (await req(`/admin/messages/${keyA}`, { token: tokenA })).json()) as any).data;
    expect(msgs[0].status).toBe('NEW');
  });

  it('non-members get the same answer for real and made-up businesses', async () => {
    const real = await req(`/admin/bookings/${keyA}`, { token: tokenB });
    const fake = await req('/admin/bookings/does_not_exist', { token: tokenB });
    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
  });

  it('owners cannot use operator-only routes', async () => {
    const routes: [string, string, unknown][] = [
      ['GET', '/admin/sectors', undefined],
      ['POST', '/admin/sectors', { key: keyA, name: 'x', hours: {} }],
      ['GET', '/admin/default-business', undefined],
      ['PUT', '/admin/default-business', { businessType: keyA }],
      ['POST', '/admin/stream-token', { businessType: keyA }],
      ['POST', '/admin/products', { id: productA, business_type: keyA, vendor_id: keyA, name: 'x' }],
      ['POST', '/admin/vendors', { id: keyA, name: 'x', business_type: keyA }],
    ];
    for (const [method, path, body] of routes) {
      expect([method, path, (await req(path, { method, token: tokenA, body })).status]).toEqual([method, path, 401]);
    }
  });

  it('staff can read and handle messages but not change settings or the team', async () => {
    expect((await req(`/account/businesses/${keyA}/members`, { token: tokenA, body: { email: 'front@clinic.example', role: 'staff' } })).status).toBe(200);
    expect(sentEmails.at(-1)!.to).toBe('front@clinic.example');
    const staff = await signIn('front@clinic.example');
    expect((await req(`/admin/bookings/${keyA}`, { token: staff })).status).toBe(200);
    expect((await req(`/admin/messages/${keyA}/m1`, { method: 'PATCH', token: staff, body: { status: 'DONE' } })).status).toBe(200);
    expect((await req(`/admin/config/${keyA}`, { method: 'PUT', token: staff, body: { greeting: 'x' } })).status).toBe(403);
    expect((await req(`/admin/sectors/${keyA}`, { method: 'PUT', token: staff, body: { name: 'xx' } })).status).toBe(403);
    expect((await req(`/admin/products/${keyA}`, { token: staff, body: { name: 'X', priceCents: 1, durationMinutes: 30 } })).status).toBe(403);
    expect((await req(`/account/businesses/${keyA}/members`, { token: staff })).status).toBe(403);
    // Staff of A is still nobody at B.
    expect((await req(`/admin/bookings/${keyB}`, { token: staff })).status).toBe(403);
  });

  it('a removed member loses access immediately', async () => {
    await req(`/account/businesses/${keyA}/members`, { token: tokenA, body: { email: 'temp@clinic.example', role: 'staff' } });
    const temp = await signIn('temp@clinic.example');
    expect((await req(`/admin/bookings/${keyA}`, { token: temp })).status).toBe(200);
    const members = ((await (await req(`/account/businesses/${keyA}/members`, { token: tokenA })).json()) as any).data;
    const id = members.find((m: any) => m.email === 'temp@clinic.example').userId;
    expect((await req(`/account/businesses/${keyA}/members/${id}`, { method: 'DELETE', token: tokenA })).status).toBe(200);
    expect((await req(`/admin/bookings/${keyA}`, { token: temp })).status).toBe(403);
  });

  it('the last owner cannot be removed or demoted', async () => {
    const members = ((await (await req(`/account/businesses/${keyA}/members`, { token: tokenA })).json()) as any).data;
    const me = members[0].userId;
    expect((await req(`/account/businesses/${keyA}/members/${me}`, { method: 'DELETE', token: tokenA })).status).toBe(409);
    expect((await req(`/account/businesses/${keyA}/members/${me}`, { method: 'PATCH', token: tokenA, body: { role: 'staff' } })).status).toBe(409);
  });

  it('owners edit their own business and services', async () => {
    const put = await req(`/admin/sectors/${keyA}`, { method: 'PUT', token: tokenA, body: { phone: '+91 90000 00001', hours: { mon: '8am–1pm' } } });
    expect(put.status).toBe(200);
    expect((await put.json() as any).data).toMatchObject({ phone: '+919000000001', hours: { mon: '8am–1pm' }, name: 'Sharma Dental Care' });
    const add = await req(`/admin/products/${keyA}`, { token: tokenA, body: { name: 'Root canal', priceCents: 600000, durationMinutes: 90 } });
    expect(add.status).toBe(201);
    const id = (await add.json() as any).data.id;
    expect(id.startsWith(`${keyA}-svc-`)).toBe(true);
    expect((await req(`/admin/products/${keyA}/${id}`, { method: 'PUT', token: tokenA, body: { priceCents: 550000 } })).status).toBe(200);
    expect((await req(`/admin/products/${keyA}/${id}`, { method: 'DELETE', token: tokenA })).status).toBe(200);
    const rows = ((await (await req(`/admin/products/${keyA}`, { token: tokenA })).json()) as any).data;
    expect(rows.find((p: any) => p.id === id)).toMatchObject({ priceCents: 550000, isActive: false });
  });
});

describe('the operator admin key still works', () => {
  it('reaches every business, including the seeded US one', async () => {
    const token = await signIn('x@example.com');
    const key = await createBiz(token);
    for (const k of ['advanced_vtech', key]) {
      for (const path of [`/admin/sectors/${k}`, `/admin/products/${k}`, `/admin/bookings/${k}`, `/admin/messages/${k}`, `/admin/transcripts/${k}`, `/admin/config/${k}`, `/account/businesses/${k}/members`]) {
        expect([path, (await req(path, { admin: ADMIN })).status]).toEqual([path, 200]);
      }
    }
    expect((await req('/admin/sectors', { admin: ADMIN })).status).toBe(200);
    expect((await req('/admin/default-business', { admin: ADMIN })).status).toBe(200);
  });

  it('a wrong admin key is refused even alongside a valid owner token', async () => {
    const token = await signIn('y@example.com');
    const key = await createBiz(token);
    expect((await req(`/admin/bookings/${key}`, { admin: 'wrong', token })).status).toBe(401);
    expect((await req(`/admin/bookings/${key}`, { admin: '', token })).status).toBe(401);
    expect((await req('/admin/bookings/advanced_vtech')).status).toBe(401);
  });

  it('fails closed when ADMIN_SECRET is unset', async () => {
    env = makeEnv({ ADMIN_SECRET: '' });
    expect((await req('/admin/bookings/advanced_vtech', { admin: '' })).status).toBe(401);
    expect((await req('/admin/sectors', { admin: '' })).status).toBe(401);
  });
});
