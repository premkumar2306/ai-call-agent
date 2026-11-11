import { SignJWT, jwtVerify } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { businessMembers, loginCodes, sectors, users, vendors, products } from '../db/schema';
import { timingSafeEqual, tokenSecretKey } from '../config';
import { parseHoursRange } from './tool-router.service';
import type { Env } from '../types';
import { COUNTRIES, inferCountry, isValidCountryCode, isValidLocale } from '../utils/locale';
import { verticalForKind } from './verticals';

// Business-owner accounts: email one-time codes, owner session tokens, and
// which businesses (sectors rows) a user may manage.
//
// Sign-up and sign-in are the same flow — the account is created the first
// time a code is verified — so the API never says whether an address already
// has an account (no user enumeration).

export const ROLES = ['owner', 'staff'] as const;
export type Role = typeof ROLES[number];

export const LOGIN_CODE_TTL_SECONDS = 10 * 60;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const OWNER_SESSION_TTL_SECONDS = 7 * 24 * 3600;
const OWNER_AUDIENCE = 'avery-owner';

// ── Small validators (pure, unit-tested) ───────────────────────────────────

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// E.164 after stripping spaces, dashes, dots and parentheses.
export function normalizePhoneE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// ── Keys ───────────────────────────────────────────────────────────────────
// Derived from TOKEN_SECRET with a purpose prefix, so an owner token can
// never be confused with a caller session or media-stream token (those are
// signed with TOKEN_SECRET itself) and the login-code HMAC key is separate
// from both.

function derivedKey(env: Env, purpose: string): Uint8Array {
  const base = tokenSecretKey(env); // fails closed in production
  const prefix = new TextEncoder().encode(`${purpose}:`);
  const out = new Uint8Array(prefix.length + base.length);
  out.set(prefix);
  out.set(base, prefix.length);
  return out;
}

async function hmacHex(key: Uint8Array, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

// Hash of an identifier for rate-limit keys (KV keys shouldn't hold raw emails).
export function identifierHash(env: Env, identifier: string): Promise<string> {
  return hmacHex(derivedKey(env, 'rate-limit'), identifier).then(h => h.slice(0, 32));
}

// ── One-time login codes ───────────────────────────────────────────────────

// Uniform 6-digit code (rejection sampling avoids modulo bias).
export function generateLoginCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

export function hashLoginCode(env: Env, identifier: string, code: string): Promise<string> {
  return hmacHex(derivedKey(env, 'login-code'), `${identifier}\n${code}`);
}

export const emailIdentifier = (email: string) => `email:${email}`;

/** Creates a fresh code for `identifier`, replacing any earlier one. */
export async function issueLoginCode(env: Env, identifier: string, now = new Date()): Promise<string> {
  const code = generateLoginCode();
  const codeHash = await hashLoginCode(env, identifier, code);
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_SECONDS * 1000);
  await getDb(env.DB).insert(loginCodes)
    .values({ identifier, codeHash, attempts: 0, expiresAt, createdAt: now })
    .onConflictDoUpdate({ target: loginCodes.identifier, set: { codeHash, attempts: 0, expiresAt, createdAt: now } });
  return code;
}

/**
 * True once, for the right code within its lifetime. Every attempt counts
 * against the code (right or wrong); after LOGIN_CODE_MAX_ATTEMPTS it is dead
 * and a new one must be requested. A correct code is deleted, so it can't be
 * replayed — and two concurrent correct submissions can't both win.
 */
export async function consumeLoginCode(env: Env, identifier: string, code: unknown, now = new Date()): Promise<boolean> {
  const db = getDb(env.DB);
  const [row] = await db.update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(and(
      eq(loginCodes.identifier, identifier),
      sql`${loginCodes.attempts} < ${LOGIN_CODE_MAX_ATTEMPTS}`,
      sql`${loginCodes.expiresAt} > ${Math.floor(now.getTime() / 1000)}`,
    ))
    .returning({ codeHash: loginCodes.codeHash });
  if (!row) return false;
  // Hash whatever was sent, so a malformed code costs the same as a wrong one.
  const given = await hashLoginCode(env, identifier, typeof code === 'string' ? code.trim() : '');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim()) || !timingSafeEqual(given, row.codeHash)) return false;
  const deleted = await db.delete(loginCodes)
    .where(and(eq(loginCodes.identifier, identifier), eq(loginCodes.codeHash, row.codeHash)))
    .returning({ identifier: loginCodes.identifier });
  return deleted.length === 1;
}

// ── Users ──────────────────────────────────────────────────────────────────

export type UserRow = typeof users.$inferSelect;

export async function findOrCreateUser(env: Env, email: string): Promise<UserRow> {
  const db = getDb(env.DB);
  await db.insert(users)
    .values({ id: crypto.randomUUID(), email, createdAt: new Date() })
    .onConflictDoNothing({ target: users.email });
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function getUser(env: Env, id: string): Promise<UserRow | null> {
  const [user] = await getDb(env.DB).select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

// ── Owner session tokens ───────────────────────────────────────────────────
// Sent as `Authorization: Bearer`. A cookie would be third-party here (the
// admin UI on pages.dev calls the Worker on workers.dev) and browsers block
// those, so the UI keeps the token in localStorage instead.

export async function signOwnerToken(env: Env, user: Pick<UserRow, 'id' | 'sessionVersion'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sv: user.sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setAudience(OWNER_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + OWNER_SESSION_TTL_SECONDS)
    .sign(derivedKey(env, 'owner-session'));
}

/** The signed-in user, or null for a bad/expired/logged-out token. */
export async function verifyOwnerToken(env: Env, token: string): Promise<UserRow | null> {
  let sub: string, sv: unknown;
  try {
    const { payload } = await jwtVerify(token, derivedKey(env, 'owner-session'), {
      algorithms: ['HS256'], audience: OWNER_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') return null;
    sub = payload.sub; sv = payload.sv;
  } catch {
    return null;
  }
  const user = await getUser(env, sub);
  return user && user.sessionVersion === sv ? user : null;
}

/** Ends every session of this user ("log out" signs out all devices). */
export async function revokeSessions(env: Env, userId: string): Promise<void> {
  await getDb(env.DB).update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, userId));
}

// ── Memberships ────────────────────────────────────────────────────────────

export async function getRole(env: Env, userId: string, businessKey: string): Promise<Role | null> {
  const [row] = await getDb(env.DB).select({ role: businessMembers.role }).from(businessMembers)
    .where(and(eq(businessMembers.userId, userId), eq(businessMembers.businessKey, businessKey)))
    .limit(1);
  return (row?.role as Role | undefined) ?? null;
}

export function roleAllows(role: Role | null, needed: Role): boolean {
  if (!role) return false;
  return needed === 'staff' ? role === 'staff' || role === 'owner' : role === 'owner';
}

export async function listBusinessesFor(env: Env, userId: string) {
  return getDb(env.DB)
    .select({ key: sectors.key, name: sectors.name, kind: sectors.kind, role: businessMembers.role })
    .from(businessMembers)
    .innerJoin(sectors, eq(sectors.key, businessMembers.businessKey))
    .where(eq(businessMembers.userId, userId))
    .orderBy(sectors.name);
}

export async function listMembers(env: Env, businessKey: string) {
  return getDb(env.DB)
    .select({ userId: users.id, email: users.email, name: users.name, role: businessMembers.role, addedAt: businessMembers.createdAt })
    .from(businessMembers)
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(eq(businessMembers.businessKey, businessKey))
    .orderBy(users.email);
}

export async function addMember(env: Env, businessKey: string, email: string, role: Role): Promise<UserRow> {
  const user = await findOrCreateUser(env, email);
  await getDb(env.DB).insert(businessMembers)
    .values({ businessKey, userId: user.id, role, createdAt: new Date() })
    .onConflictDoUpdate({ target: [businessMembers.businessKey, businessMembers.userId], set: { role } });
  return user;
}

/** 'last_owner' when removing/demoting would leave the business without an owner. */
export async function changeMember(env: Env, businessKey: string, userId: string, role: Role | null): Promise<'ok' | 'not_found' | 'last_owner'> {
  const db = getDb(env.DB);
  const current = await getRole(env, userId, businessKey);
  if (!current) return 'not_found';
  if (current === 'owner' && role !== 'owner') {
    const owners = await db.select({ userId: businessMembers.userId }).from(businessMembers)
      .where(and(eq(businessMembers.businessKey, businessKey), eq(businessMembers.role, 'owner')));
    if (owners.length <= 1) return 'last_owner';
  }
  const where = and(eq(businessMembers.businessKey, businessKey), eq(businessMembers.userId, userId));
  if (role) await db.update(businessMembers).set({ role }).where(where);
  else await db.delete(businessMembers).where(where);
  return 'ok';
}

// ── Onboarding: create a business ──────────────────────────────────────────

export const BUSINESS_KINDS: Record<string, string> = {
  clinic: 'Clinic / doctor',
  dental: 'Dental clinic',
  salon: 'Salon / barber',
  spa: 'Spa / wellness',
  auto_shop: 'Auto repair shop',
  fitness: 'Gym / fitness studio',
  vet: 'Veterinary clinic',
  lawyer: 'Law firm / advocate',
  other: 'Other',
};

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface ServiceInput {
  name: string;
  priceCents: number;
  durationMinutes: number;
  description: string;
  /** Optional category ("CONSULTATION", a practice area like "FAMILY"); default SERVICES. */
  category?: string;
}

export interface BusinessInput {
  name: string;
  kind: string;
  address?: string;
  phone?: string;          // staff line for live transfers (E.164)
  timezone: string;
  currency: string;
  // Country and locale (prices, dates, phone numbers); from the wizard, or
  // inferred from currency/timezone so an INR business is set up as Indian.
  countryCode: string;
  locale: string;
  hours: Record<string, string>;
  about?: string;
  notifyEmail?: string;
  services: ServiceInput[];
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** "9am–6pm" style, open strictly before close. */
export function isValidHoursRange(range: unknown): range is string {
  if (typeof range !== 'string' || range.length > 40) return false;
  const p = parseHoursRange(range);
  if (!p) return false;
  if (p.openH > 23 || p.closeH > 24 || p.openM > 59 || p.closeM > 59) return false;
  return p.closeH * 60 + p.closeM > p.openH * 60 + p.openM;
}

export function parseServices(raw: unknown, { min = 1, max = 50 } = {}): ServiceInput[] | string {
  if (!Array.isArray(raw) || raw.length < min) return min ? 'Add at least one service' : 'services must be a list';
  if (raw.length > max) return `At most ${max} services`;
  const out: ServiceInput[] = [];
  for (const s of raw) {
    const svc = parseService(s);
    if (typeof svc === 'string') return svc;
    out.push(svc);
  }
  return out;
}

export function parseService(s: any): ServiceInput | string {
  const name = typeof s?.name === 'string' ? s.name.trim() : '';
  if (!name || name.length > 120) return 'Each service needs a name (up to 120 characters)';
  const priceCents = s.priceCents;
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000) return `Price for “${name}” is not valid`;
  const durationMinutes = s.durationMinutes;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 600) return `Duration for “${name}” must be 5–600 minutes`;
  const description = typeof s.description === 'string' ? s.description.trim().slice(0, 500) : '';
  let category: string | undefined;
  if (s.category !== undefined && s.category !== null && s.category !== '') {
    category = typeof s.category === 'string' ? s.category.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '';
    if (!category || category.length > 40) return `Category for “${name}” is not valid`;
  }
  return { name, priceCents, durationMinutes, description, ...(category ? { category } : {}) };
}

/** Validates the onboarding wizard's payload. Returns an error message or the clean input. */
export function parseBusinessInput(body: any): BusinessInput | string {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 80) return 'Business name must be 2–80 characters';
  const kind = typeof body.kind === 'string' && body.kind in BUSINESS_KINDS ? body.kind : null;
  if (!kind) return 'Choose a business type';
  if (!isValidTimezone(body.timezone)) return 'Choose a valid time zone';
  const currency = typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency) ? body.currency : null;
  if (!currency) return 'Choose a currency';
  if (body.country_code !== undefined && !isValidCountryCode(body.country_code)) return 'Choose a supported country';
  const countryCode: string = body.country_code ?? inferCountry(body.timezone, currency);
  if (body.locale !== undefined && !isValidLocale(body.locale)) return 'Choose a valid language/format';
  const locale: string = body.locale ?? COUNTRIES[countryCode].locale;

  const hours: Record<string, string> = {};
  if (!body.hours || typeof body.hours !== 'object') return 'Opening hours are required';
  for (const d of DAYS) {
    const v = body.hours[d];
    if (v === undefined || v === null || v === '') continue;
    if (!isValidHoursRange(v)) return `Opening hours for ${d} are not valid (use e.g. 9am–6pm)`;
    hours[d] = v;
  }
  if (!Object.keys(hours).length) return 'Open at least one day a week';

  let address: string | undefined;
  if (body.address !== undefined && body.address !== '') {
    if (typeof body.address !== 'string' || body.address.trim().length > 300) return 'Address is too long';
    address = body.address.trim() || undefined;
  }
  let phone: string | undefined;
  if (body.phone !== undefined && body.phone !== '') {
    const p = normalizePhoneE164(body.phone);
    if (!p) return 'Staff phone must be a full number with country code, e.g. +91 98765 43210';
    phone = p;
  }
  let notifyEmail: string | undefined;
  if (body.notifyEmail !== undefined && body.notifyEmail !== '') {
    const e = normalizeEmail(body.notifyEmail);
    if (!e) return 'Notification email is not valid';
    notifyEmail = e;
  }
  const about = typeof body.about === 'string' && body.about.trim() ? body.about.trim().slice(0, 4000) : undefined;

  const services = parseServices(body.services);
  if (typeof services === 'string') return services;

  return { name, kind, address, phone, timezone: body.timezone, currency, countryCode, locale, hours, about, notifyEmail, services };
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/, '');
  return slug || 'business';
}

function randomSuffix(len: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => alphabet[b % alphabet.length]).join('');
}

export function serviceProductId(businessKey: string): string {
  return `${businessKey}-svc-${randomSuffix(8)}`;
}

/** Creates the sector, its vendor, its services and the owner membership in one batch. */
export async function createBusiness(env: Env, owner: UserRow, input: BusinessInput): Promise<string> {
  const db = getDb(env.DB);
  const base = slugify(input.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = `${base}_${randomSuffix(attempt < 3 ? 4 : 8)}`;
    const now = new Date();
    try {
      await db.batch([
        db.insert(sectors).values({
          key, name: input.name, model: 'service', categories: [...new Set(['SERVICES', ...input.services.map(s => s.category ?? 'SERVICES')])], hours: input.hours,
          timezone: input.timezone, currency: input.currency, countryCode: input.countryCode, locale: input.locale, address: input.address, phone: input.phone,
          about: input.about, notifyEmail: input.notifyEmail ?? owner.email, capacity: 1, kind: input.kind,
          // The call script for this kind of business (a clinic, a law firm…).
          vertical: storedVertical(input.kind),
          isActive: true, createdAt: now, updatedAt: now,
        }),
        db.insert(vendors).values({
          id: key, name: input.name, businessType: key, contactEmail: owner.email, isActive: true, createdAt: now,
        }),
        ...input.services.map(s => db.insert(products).values({
          id: serviceProductId(key), businessType: key, vendorId: key, vendorName: input.name,
          name: s.name, category: s.category ?? 'SERVICES', type: 'SERVICE_APPOINTMENT', fulfillmentType: 'SERVICE_BOOKING',
          description: s.description, priceCents: s.priceCents, originalPriceCents: s.priceCents,
          durationMinutes: s.durationMinutes, isActive: true, createdAt: now,
        })),
        db.insert(businessMembers).values({ businessKey: key, userId: owner.id, role: 'owner', createdAt: now }),
      ]);
    } catch (e: any) {
      // Key collision (a sectors or vendors row with this key) — try another suffix.
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e)) && attempt < 4) continue;
      throw e;
    }
    await env.CACHE.delete('sectors_list');
    return key;
  }
  throw new Error('Could not allocate a business key');
}

// ── Editing a business (owner settings page) ───────────────────────────────

/** sectors.vertical for a kind: null for 'general' (the column's default meaning). */
export function storedVertical(kind: string): string | null {
  const v = verticalForKind(kind);
  return v === 'general' ? null : v;
}

/** A spoken assistant name: letters, spaces, apostrophes, hyphens and dots; 2–30 characters. */
export function parseAssistantName(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 30 && /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name) ? name : undefined;
}

export interface BusinessPatch {
  vertical?: string | null; assistantName?: string | null;
  name?: string; kind?: string; address?: string | null; phone?: string | null; website?: string | null;
  timezone?: string; currency?: string; hours?: Record<string, string>; about?: string | null;
  notifyEmail?: string | null; capacity?: number; countryCode?: string; locale?: string;
}

/** Partial update from the owner's Business tab. Only the fields present are changed; '' clears optional ones. */
export function parseBusinessPatch(body: any): BusinessPatch | string {
  if (!body || typeof body !== 'object') return 'Nothing to update';
  const out: BusinessPatch = {};
  const optionalText = (v: unknown, max: number): string | null | undefined =>
    v === undefined ? undefined : typeof v === 'string' ? (v.trim().slice(0, max) || null) : undefined;

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 2 || name.length > 80) return 'Business name must be 2–80 characters';
    out.name = name;
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !(body.kind in BUSINESS_KINDS)) return 'Choose a business type';
    out.kind = body.kind;
    // A new business type brings its call script (doctor / lawyer wording, safety rules).
    out.vertical = storedVertical(body.kind);
  }
  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) return 'Choose a valid time zone';
    out.timezone = body.timezone;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) return 'Choose a currency';
    out.currency = body.currency;
  }
  if (body.country_code !== undefined) {
    if (!isValidCountryCode(body.country_code)) return 'Choose a supported country';
    out.countryCode = body.country_code;
    // A country switch brings its number/date format unless one is given.
    if (body.locale === undefined) out.locale = COUNTRIES[body.country_code].locale;
  }
  if (body.locale !== undefined) {
    if (!isValidLocale(body.locale)) return 'Choose a valid language/format';
    out.locale = body.locale;
  }
  if (body.hours !== undefined) {
    if (!body.hours || typeof body.hours !== 'object') return 'Opening hours are not valid';
    const hours: Record<string, string> = {};
    for (const d of DAYS) {
      const v = body.hours[d];
      if (v === undefined || v === null || v === '') continue;
      if (!isValidHoursRange(v)) return `Opening hours for ${d} are not valid (use e.g. 9am–6pm)`;
      hours[d] = v;
    }
    if (!Object.keys(hours).length) return 'Open at least one day a week';
    out.hours = hours;
  }
  if (body.phone !== undefined) {
    if (body.phone === '' || body.phone === null) out.phone = null;
    else {
      const p = normalizePhoneE164(body.phone);
      if (!p) return 'Staff phone must be a full number with country code, e.g. +91 98765 43210';
      out.phone = p;
    }
  }
  const notify = body.notifyEmail ?? body.notify_email;
  if (notify !== undefined) {
    if (notify === '' || notify === null) out.notifyEmail = null;
    else {
      const e = normalizeEmail(notify);
      if (!e) return 'Notification email is not valid';
      out.notifyEmail = e;
    }
  }
  if (body.capacity !== undefined) {
    if (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 50) return 'Capacity must be 1–50';
    out.capacity = body.capacity;
  }
  const assistant = body.assistant_name ?? body.assistantName;
  if (assistant !== undefined) {
    const n = parseAssistantName(assistant);
    if (n === undefined) return 'Assistant name must be 2–30 letters';
    out.assistantName = n;
  }
  const address = optionalText(body.address, 300); if (address !== undefined) out.address = address;
  const website = optionalText(body.website, 200); if (website !== undefined) out.website = website;
  const about = optionalText(body.about, 4000); if (about !== undefined) out.about = about;
  if (!Object.keys(out).length) return 'Nothing to update';
  return out;
}
