import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { parseBusinessInput, parseBusinessPatch, storedVertical, BUSINESS_KINDS, parseAssistantName } from '../src/services/accounts';
import { getVertical, verticalForKind, assistantNameOf, VERTICALS } from '../src/services/verticals';
import { buildAgentRules, buildSystemPrompt } from '../src/services/turn.service';
import { getToolDefinitions } from '../src/services/tool-router.service';
import { parseResourceInput } from '../src/services/self-serve';
import { resolveBusinessType } from '../src/routes/whatsapp';
import { getSector } from '../src/services/sector.service';
import { saveTranscript, webSessionCallSid } from '../src/services/transcript.service';
import { createD1, createKV, executionCtx } from './stubs/d1';
import type { Env, SectorMeta } from '../src/types';

const ADMIN = 'admin-secret-for-tests-0123456789';
const TOKEN_SECRET = 't'.repeat(40);

// ── Kind → vertical ────────────────────────────────────────────────────────

describe('business type picks the call script', () => {
  it('maps every kind to a vertical', () => {
    expect(Object.keys(BUSINESS_KINDS)).toContain('lawyer');
    expect(BUSINESS_KINDS.lawyer).toBe('Law firm / advocate');
    const map = Object.fromEntries(Object.keys(BUSINESS_KINDS).map(k => [k, verticalForKind(k)]));
    expect(map).toEqual({
      clinic: 'clinic', dental: 'clinic', salon: 'appointments', spa: 'appointments', auto_shop: 'general',
      fitness: 'appointments', vet: 'appointments', lawyer: 'legal', other: 'appointments',
    });
    expect(storedVertical('auto_shop')).toBeNull();
    for (const v of Object.values(map)) expect(VERTICALS[v]).toBeDefined();
  });

  it('a dental practice hears "dentist", keeping the doctor_id argument', () => {
    const v = getVertical({ vertical: 'clinic', kind: 'dental' });
    expect(v.key).toBe('clinic');
    expect(v.resources).toMatchObject({ param: 'doctor_id', noun: 'dentist', heading: "Dentists (book with the dentist's [doctor_id])" });
    const rules = buildAgentRules('d', 'Smile Dental', 'voice', v);
    expect(rules).toMatch(/the dentist confirms the cost|that dentist's consultation fee/);
    expect(rules).toMatch(/doctor_id/);
    expect(rules).not.toMatch(/\bdoctors?\b/);
    // A plain clinic is unchanged.
    expect(getVertical({ vertical: 'clinic' })).toBe(VERTICALS.clinic);
    expect(getVertical({ vertical: 'clinic', kind: 'clinic' })).toBe(VERTICALS.clinic);
  });

  it('a salon gets no vehicle questions and calls itself a salon', () => {
    const meta = { vertical: 'appointments', kind: 'salon' } as SectorMeta;
    const rules = buildAgentRules('s', 'Glow Salon', 'voice', getVertical(meta), 'en', 'Avery');
    expect(rules).not.toMatch(/vehicle|driving|service advisor|technician/i);
    expect(rules).toMatch(/our salon/);
    const tools = getToolDefinitions('s', { ...meta, name: 'Glow', model: 'service', categories: [], hours: {}, timezone: 'Asia/Kolkata', currency: 'INR' });
    expect((tools.find(t => t.name === 'book_appointment')!.parameters as any).properties.vehicle).toBeUndefined();
  });

  it('a business without a vertical still gets the original script', () => {
    expect(getVertical({})).toBe(VERTICALS.general);
    expect(getVertical({ kind: 'dental' })).toBe(VERTICALS.general);
  });

  it('the wizard and the Business tab set the vertical with the kind', () => {
    expect(parseBusinessPatch({ kind: 'lawyer' })).toEqual({ kind: 'lawyer', vertical: 'legal' });
    expect(parseBusinessPatch({ kind: 'auto_shop' })).toEqual({ kind: 'auto_shop', vertical: null });
    expect(parseBusinessPatch({ name: 'Same Kind' })).toEqual({ name: 'Same Kind' });
    expect(typeof parseBusinessInput({ kind: 'lawyer' })).toBe('string'); // still validated as a whole
  });

  it('the migration backfills signed-up businesses only', () => {
    const db = createD1() as any;
    const sql = readFileSync(new URL('../drizzle/0018_multi_vertical.sql', import.meta.url), 'utf8');
    const backfill = sql.slice(sql.indexOf('UPDATE sectors SET vertical'), sql.indexOf(';', sql.indexOf('UPDATE sectors SET vertical')) + 1);
    const ins = (key: string, kind: string | null, vertical: string | null) => db.sqlite.prepare(
      `INSERT INTO sectors (key, name, model, categories, hours, kind, vertical, created_at, updated_at) VALUES (?, ?, 'service', '[]', '{}', ?, ?, 0, 0)`,
    ).run(key, key, kind, vertical);
    ins('a_dental', 'dental', null); ins('a_law', 'lawyer', null); ins('a_salon', 'salon', null);
    ins('a_auto', 'auto_shop', null); ins('a_set', 'dental', 'appointments'); ins('a_none', null, null);
    db.sqlite.exec(backfill);
    const rows = Object.fromEntries((db.sqlite.prepare(`SELECT key, vertical FROM sectors WHERE key LIKE 'a\\_%' ESCAPE '\\'`).all() as any[]).map(r => [r.key, r.vertical]));
    expect(rows).toEqual({ a_dental: 'clinic', a_law: 'legal', a_salon: 'appointments', a_auto: null, a_set: 'appointments', a_none: null });
    const us = db.sqlite.prepare(`SELECT vertical, assistant_name FROM sectors WHERE key = 'advanced_vtech'`).get();
    if (us) expect(us).toMatchObject({ vertical: null, assistant_name: 'Mogi' });
  });
});

describe('assistant name', () => {
  it('defaults to Avery and is configurable', () => {
    expect(assistantNameOf(null)).toBe('Avery');
    expect(assistantNameOf({ assistantName: 'Priya' })).toBe('Priya');
    expect(parseAssistantName('  Priya  ')).toBe('Priya');
    expect(parseAssistantName('')).toBeNull();
    expect(parseAssistantName('x')).toBeUndefined();
    expect(parseAssistantName('<script>')).toBeUndefined();
    expect(parseAssistantName('प्रिया')).toBe('प्रिया');
  });

  it('is what the prompt calls the assistant', () => {
    const meta = { name: 'Glow', model: 'service', categories: [], hours: {}, timezone: 'UTC', currency: 'USD' } as SectorMeta;
    const session = { sub: 'x', businessType: 'g', iat: 0, exp: 0, account: { tier: 'BASIC', store_credit_cents: 0 } } as any;
    const text = (m: SectorMeta) => buildSystemPrompt({ businessType: 'g', sectorMeta: m, products: [], session, orders: [] })[0].text;
    expect(text(meta)).toMatch(/^You are Avery, the friendly receptionist/);
    expect(text({ ...meta, assistantName: 'Mogi' })).toMatch(/^You are Mogi, the friendly receptionist/);
  });
});

describe('practitioner input', () => {
  const ok = { name: 'Dr. Asha Rao', hours: { mon: '10am–1pm, 5pm–9pm', sun: '' }, slotMinutes: 20, feeCents: 50000, categories: ['family law', 'PROPERTY'] };
  it('accepts a full form and normalises categories', () => {
    expect(parseResourceInput(ok)).toEqual({
      name: 'Dr. Asha Rao', role: null, hours: { mon: '10am–1pm, 5pm–9pm' }, slotMinutes: 20, feeCents: 50000,
      about: null, categories: ['FAMILY_LAW', 'PROPERTY'], isActive: true,
    });
  });
  it.each([
    [{ name: 'x' }, /Name/],
    [{ hours: {} }, /at least one day/],
    [{ hours: { mon: 'whenever' } }, /mon/],
    [{ slotMinutes: 2 }, /5–240/],
    [{ feeCents: -1 }, /Fee/],
  ])('rejects %j', (over, msg) => {
    expect(parseResourceInput({ ...ok, ...over })).toMatch(msg);
  });
  it('an edit keeps what is not sent', () => {
    const existing = parseResourceInput(ok) as any;
    expect(parseResourceInput({ isActive: false }, existing)).toEqual({ ...existing, isActive: false });
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────

let env: Env;
let sentEmails: { to: string; subject: string }[];

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
      sentEmails.push({ to: body.to[0], subject: body.subject });
      return new Response('{"id":"x"}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

let ipCounter = 0;
function req(path: string, init: { method?: string; body?: unknown; token?: string; admin?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': `10.1.0.${++ipCounter % 250}` };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.admin !== undefined) headers['x-admin-key'] = init.admin;
  return app.request(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }, env, executionCtx as any);
}

async function signIn(email: string): Promise<string> {
  await req('/account/login/start', { body: { email } });
  const code = sentEmails.at(-1)!.subject.slice(0, 6);
  const res = await req('/account/login/verify', { body: { email, code } });
  return (await res.json() as any).data.token;
}

const wizard = (over: Record<string, unknown> = {}) => ({
  name: 'Kulkarni Law Chambers', kind: 'lawyer', timezone: 'Asia/Kolkata', currency: 'INR', country_code: 'IN',
  hours: { mon: '10am–6pm', tue: '10am–6pm' },
  services: [{ name: 'Family law consultation', priceCents: 0, durationMinutes: 30, category: 'family' }],
  ...over,
});

async function createBiz(token: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await req('/account/businesses', { token, body: wizard(over) });
  expect(res.status).toBe(201);
  return (await res.json() as any).data.key;
}

const lawyer = { name: 'Adv. Meera Kulkarni', role: 'Partner', hours: { mon: '10am–1pm' }, slotMinutes: 30, feeCents: 150000, categories: ['FAMILY'] };

describe('signup', () => {
  it('a law firm signs up on the legal script, with its service category', async () => {
    const token = await signIn('law@example.com');
    const key = await createBiz(token);
    const meta = await getSector(env, key);
    expect(meta).toMatchObject({ kind: 'lawyer', vertical: 'legal', countryCode: 'IN' });
    expect(meta!.assistantName).toBeUndefined();
    const prods = (await (await req(`/admin/products/${key}`, { token })).json() as any).data;
    expect(prods[0].category).toBe('FAMILY');
  });

  it('an auto shop keeps the general script; a dentist gets the clinic script', async () => {
    const token = await signIn('mixed@example.com');
    expect((await getSector(env, await createBiz(token, { kind: 'auto_shop', name: 'Fix It Garage' })))!.vertical).toBeUndefined();
    expect((await getSector(env, await createBiz(token, { kind: 'dental', name: 'Smile Dental' })))!.vertical).toBe('clinic');
  });

  it('changing the business type in the Business tab changes the script', async () => {
    const token = await signIn('switch@example.com');
    const key = await createBiz(token, { kind: 'other', name: 'Some Office' });
    expect((await getSector(env, key))!.vertical).toBe('appointments');
    const put = await req(`/admin/sectors/${key}`, { method: 'PUT', token, body: { kind: 'lawyer', country_code: 'US', assistant_name: 'Priya' } });
    expect(put.status).toBe(200);
    expect((await put.json() as any).data).toMatchObject({ kind: 'lawyer', vertical: 'legal', countryCode: 'US', locale: 'en-US', assistantName: 'Priya' });
  });

  it('a new business gets the default plan, with its trial, only when one is marked default', async () => {
    const token = await signIn('plan@example.com');
    const before = await createBiz(token, { name: 'Before Default' });
    expect((await (await req(`/billing/${before}`, { token })).json() as any).data.state).toBe('off');
    expect((await req('/admin/billing/plans/in_starter', { method: 'PUT', admin: ADMIN, body: {
      name: 'Starter', monthlyFeePaise: 299900, includedMinutes: 300, overagePaisePerMinute: 700, trialDays: 14, isDefault: true,
    } })).status).toBe(200);
    const after = await createBiz(token, { name: 'After Default' });
    const bill = (await (await req(`/billing/${after}`, { token })).json() as any).data;
    expect(bill.state).toBe('trialing');
    // Only one default at a time.
    await req('/admin/billing/plans/other', { method: 'PUT', admin: ADMIN, body: { name: 'Other', monthlyFeePaise: 1, includedMinutes: 1, overagePaisePerMinute: 1, isDefault: true } });
    const plans = (await (await req('/admin/billing/plans', { admin: ADMIN })).json() as any).data;
    expect(plans.filter((p: any) => p.isDefault).map((p: any) => p.id)).toEqual(['other']);
  });
});

describe('practitioners (owner-scoped)', () => {
  let tokenA: string, tokenB: string, keyA: string, keyB: string, idA: string;
  beforeEach(async () => {
    tokenA = await signIn('a@law.example');
    tokenB = await signIn('b@law.example');
    keyA = await createBiz(tokenA);
    keyB = await createBiz(tokenB, { name: 'Other Chambers' });
    const res = await req(`/admin/resources/${keyA}`, { token: tokenA, body: lawyer });
    expect(res.status).toBe(201);
    idA = (await res.json() as any).data.id;
  });

  it('the owner adds, edits and deactivates; callers see only active ones', async () => {
    expect(idA.startsWith(`${keyA}-res-`)).toBe(true);
    expect((await getSector(env, keyA))!.resources!.map(r => r.name)).toEqual(['Adv. Meera Kulkarni']);
    const put = await req(`/admin/resources/${keyA}/${idA}`, { method: 'PUT', token: tokenA, body: { feeCents: 200000 } });
    expect((await put.json() as any).data).toMatchObject({ feeCents: 200000, slotMinutes: 30, name: 'Adv. Meera Kulkarni' });
    expect((await req(`/admin/resources/${keyA}/${idA}`, { method: 'DELETE', token: tokenA })).status).toBe(200);
    expect((await getSector(env, keyA))!.resources).toBeUndefined();
    const list = (await (await req(`/admin/resources/${keyA}`, { token: tokenA })).json() as any).data;
    expect(list[0]).toMatchObject({ id: idA, isActive: false });
    expect((await req(`/admin/resources/${keyA}`, { token: tokenA, body: { ...lawyer, hours: {} } })).status).toBe(400);
  });

  it("owner B can't read or change A's practitioners, even through B's own path", async () => {
    expect((await req(`/admin/resources/${keyA}`, { token: tokenB })).status).toBe(403);
    expect((await req(`/admin/resources/${keyA}`, { token: tokenB, body: lawyer })).status).toBe(403);
    expect((await req(`/admin/resources/${keyA}/${idA}`, { method: 'PUT', token: tokenB, body: { name: 'Hijacked' } })).status).toBe(403);
    expect((await req(`/admin/resources/${keyA}/${idA}`, { method: 'DELETE', token: tokenB })).status).toBe(403);
    expect((await req(`/admin/resources/${keyB}/${idA}`, { method: 'PUT', token: tokenB, body: { name: 'Hijacked' } })).status).toBe(404);
    expect((await req(`/admin/resources/${keyB}/${idA}`, { method: 'DELETE', token: tokenB })).status).toBe(404);
    expect((await req(`/admin/resources/${keyA}`)).status).toBe(401);
    const list = (await (await req(`/admin/resources/${keyA}`, { admin: ADMIN })).json() as any).data;
    expect(list[0]).toMatchObject({ name: 'Adv. Meera Kulkarni', isActive: true });
  });

  it('staff can read but not change', async () => {
    await req(`/account/businesses/${keyA}/members`, { token: tokenA, body: { email: 'desk@law.example', role: 'staff' } });
    const staff = await signIn('desk@law.example');
    expect((await req(`/admin/resources/${keyA}`, { token: staff })).status).toBe(200);
    expect((await req(`/admin/resources/${keyA}`, { token: staff, body: lawyer })).status).toBe(403);
    expect((await req(`/admin/resources/${keyA}/${idA}`, { method: 'PUT', token: staff, body: { feeCents: 1 } })).status).toBe(403);
    expect((await req(`/account/businesses/${keyA}/number-request`, { token: staff, body: {} })).status).toBe(403);
  });

  it('the settings routes work on an owner login', async () => {
    expect((await req(`/admin/sectors/${keyA}/voice`, { method: 'PUT', token: tokenA, body: { voice_language: 'en' } })).status).toBe(200);
    expect((await req(`/admin/privacy/${keyA}/settings`, { method: 'PUT', token: tokenA, body: { retentionDays: 90 } })).status).toBe(200);
    const cfg = await req(`/admin/config/${keyA}`, { method: 'PUT', token: tokenA, body: { agentName: 'Priya' } });
    expect((await cfg.json() as any).data.agentName).toBe('Priya');
    expect((await getSector(env, keyA))!.assistantName).toBe('Priya');
    expect((await req(`/admin/config/${keyA}`, { method: 'PUT', token: tokenA, body: { agentName: '<b>' } })).status).toBe(400);
    expect((await req(`/admin/sectors/${keyA}/voice`, { method: 'PUT', token: tokenB, body: { voice_language: 'en' } })).status).toBe(403);
  });
});

describe('phone-number requests', () => {
  it('records one open request per business and emails the operator when configured', async () => {
    env = makeEnv({ ADMIN_NOTIFY_EMAIL: 'ops@example.com' });
    const token = await signIn('num@example.com');
    const key = await createBiz(token);
    const first = await req(`/account/businesses/${key}/number-request`, { token, body: { note: 'Pune number please' } });
    expect(first.status).toBe(201);
    expect(sentEmails.at(-1)).toMatchObject({ to: 'ops@example.com', subject: 'Phone number requested: Kulkarni Law Chambers' });
    const again = await req(`/account/businesses/${key}/number-request`, { token, body: {} });
    expect((await again.json() as any).data.alreadyRequested).toBe(true);
    const list = (await (await req('/admin/number-requests', { admin: ADMIN })).json() as any).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ businessType: key, requestedBy: 'num@example.com', note: 'Pune number please', status: 'open' });
    expect((await req('/admin/number-requests', { token })).status).toBe(401);
    expect((await req(`/admin/number-requests/${list[0].id}`, { method: 'PATCH', admin: ADMIN, body: { status: 'done' } })).status).toBe(200);
    const mine = (await (await req(`/account/businesses/${key}/number-request`, { token })).json() as any).data;
    expect(mine[0].status).toBe('done');
  });

  it('just stores the request without ADMIN_NOTIFY_EMAIL', async () => {
    const token = await signIn('num2@example.com');
    const key = await createBiz(token);
    const emails = sentEmails.length;
    expect((await req(`/account/businesses/${key}/number-request`, { token, body: {} })).status).toBe(201);
    expect(sentEmails.length).toBe(emails);
  });
});

describe('browser test sessions', () => {
  it('keep one transcript row per session, updated each turn', async () => {
    const session = { sub: 'abcdef0123456789abcdef', iat: 1_800_000_000 };
    const callSid = webSessionCallSid(session);
    expect(callSid).toBe('web-abcdef0123456789-1800000000');
    const t1 = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello' }];
    const t2 = [...t1, { role: 'user' as const, content: 'book' }, { role: 'assistant' as const, content: 'done' }];
    const id1 = await saveTranscript(env, { callSid, customerIdHashed: session.sub, businessType: 'x', turns: t1 });
    const id2 = await saveTranscript(env, { callSid, customerIdHashed: session.sub, businessType: 'x', turns: t2 });
    expect(id2).toBe(id1);
    const rows = (await env.DB.prepare('select turns from transcripts where call_sid = ?').bind(callSid).all()).results as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].turns)).toHaveLength(4);
    // A new test call (new token) is a new conversation.
    expect(webSessionCallSid({ ...session, iat: session.iat + 60 })).not.toBe(callSid);
  });
});

describe('WhatsApp status', () => {
  it('reports which settings are present as booleans, to the operator only', async () => {
    env = makeEnv({ WA_APP_SECRET: 'shh-secret', WA_VERIFY_TOKEN: 'verify-me', WA_CONFIRMATION_TEMPLATE: 'booking_confirmed' } as any);
    const res = await req('/admin/whatsapp-status', { admin: ADMIN });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('shh-secret');
    expect(text).not.toContain('verify-me');
    expect(text).not.toContain('booking_confirmed');
    expect(JSON.parse(text).data).toEqual({
      appSecret: true, verifyToken: true, accessToken: false, phoneNumberMap: false,
      confirmationTemplate: true, templateLanguage: false, graphApiVersion: false, webhookPath: '/whatsapp/webhook',
    });
    const token = await signIn('wastatus@example.com');
    expect((await req('/admin/whatsapp-status', { token })).status).toBe(401);
    expect((await req('/admin/whatsapp-status', {})).status).toBe(401);
  });
});

describe('WhatsApp routing', () => {
  it('uses the admin mapping first, then WA_PHONE_NUMBER_MAP, then the default', async () => {
    env = makeEnv({ WA_PHONE_NUMBER_MAP: JSON.stringify({ '111111': 'from_env', '222222': 'from_env' }), WA_DEFAULT_BUSINESS_TYPE: 'fallback' } as any);
    const token = await signIn('wa@example.com');
    const key = await createBiz(token);
    expect((await req('/admin/whatsapp-numbers', { method: 'PUT', admin: ADMIN, body: { phoneNumberId: '222222', businessType: key, label: 'Main' } })).status).toBe(200);
    expect(await resolveBusinessType('222222', env)).toBe(key);
    expect(await resolveBusinessType('111111', env)).toBe('from_env');
    expect(await resolveBusinessType('333333', env)).toBe('fallback');
    expect((await req('/admin/whatsapp-numbers', { method: 'PUT', admin: ADMIN, body: { phoneNumberId: 'abc', businessType: key } })).status).toBe(400);
    expect((await req('/admin/whatsapp-numbers', { method: 'PUT', admin: ADMIN, body: { phoneNumberId: '444444', businessType: 'nope' } })).status).toBe(404);
    expect((await req('/admin/whatsapp-numbers', { method: 'PUT', token, body: { phoneNumberId: '444444', businessType: key } })).status).toBe(401);
    expect(((await (await req('/admin/whatsapp-numbers', { admin: ADMIN })).json()) as any).data).toHaveLength(1);
    expect((await req('/admin/whatsapp-numbers/222222', { method: 'DELETE', admin: ADMIN })).status).toBe(200);
    expect(await resolveBusinessType('222222', env)).toBe('from_env');
  });
});
