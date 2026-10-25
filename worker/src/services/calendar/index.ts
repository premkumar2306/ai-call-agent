/**
 * External calendar integration, configured per business.
 *
 * A business connects one calendar account (OAuth, offline access) and
 * picks one of its calendars. Then:
 *   - check_availability drops slots that overlap the calendar's busy times
 *     (checkBusy), so walk-ins and staff-entered appointments aren't double
 *     booked;
 *   - book_appointment re-checks the chosen slot against the calendar, then
 *     creates an event for the booking (writeEvents);
 *   - cancel_booking deletes that event.
 *
 * D1 stays the source of truth and the double-booking lock. The calendar is
 * best effort: an outage or timeout never blocks or fails a booking, it only
 * shows up as orders.calendar_sync = 'failed' and the connection's lastError.
 *
 * Providers are adapters (./types.ts CalendarProvider). To add one, write
 * ./<provider>.ts and register it in PROVIDERS below — routes, storage and
 * the booking flow pick it up unchanged.
 */
import { eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { getDb } from '../../db/client';
import { calendarConnections, orders as ordersTable } from '../../db/schema';
import { tokenSecretKey } from '../../config';
import { encryptSecret, decryptSecret } from '../../utils/calendar-crypto';
import { toInstant, addMinutesLocal } from '../../utils/time';
import type { Env, Order, SectorMeta } from '../../types';
import { CalendarError, type CalendarProvider, type BusyInterval, type CalendarInfo } from './types';
import { googleCalendar } from './google';

export { CalendarError, type BusyInterval, type CalendarInfo } from './types';

const PROVIDERS: Record<string, CalendarProvider> = {
  [googleCalendar.id]: googleCalendar,
};

// Availability lookups sit on the live-call path; past these, carry on
// without the calendar rather than leave the caller in silence.
const BUSY_TIMEOUT_MS = 2500;
const SLOT_CHECK_TIMEOUT_MS = 2000;
const WRITE_TIMEOUT_MS = 8000;

// The 14-day window getAvailableSlots offers, plus a day of slack for
// timezone edges.
const BUSY_HORIZON_MS = 15 * 24 * 60 * 60 * 1000;

export type CalendarConnection = typeof calendarConnections.$inferSelect;

export function getProvider(id: string): CalendarProvider | null {
  return PROVIDERS[id] ?? null;
}

/** Providers this deployment can offer, for the admin UI. */
export function listProviders(env: Env): Array<{ id: string; name: string; configured: boolean }> {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, name: p.displayName, configured: providerReady(env, p) }));
}

function providerReady(env: Env, p: CalendarProvider | null): p is CalendarProvider {
  return !!p && !!env.CALENDAR_TOKEN_KEY && p.configured(env);
}

const accessTokenKey = (businessType: string) => `cal_at:${businessType}`;

// ── OAuth ──────────────────────────────────────────────────────────────────

// `state` carries the business, provider and where to send the operator
// afterwards. Signed so the public callback can't be pointed at another
// business or an arbitrary redirect target.
const STATE_PURPOSE = 'calendar-oauth';
const STATE_TTL_SECONDS = 600;

export interface OAuthState { businessType: string; provider: string; returnTo: string }

export async function signOAuthState(env: Env, s: OAuthState): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ purpose: STATE_PURPOSE, ...s })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(tokenSecretKey(env));
}

export async function verifyOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  try {
    const { payload: p } = await jwtVerify(state, tokenSecretKey(env), { algorithms: ['HS256'] });
    if (p.purpose !== STATE_PURPOSE || typeof p.businessType !== 'string'
      || typeof p.provider !== 'string' || typeof p.returnTo !== 'string') return null;
    return { businessType: p.businessType, provider: p.provider, returnTo: p.returnTo };
  } catch {
    return null;
  }
}

export function authUrl(env: Env, providerId: string, redirectUri: string, state: string): string {
  const p = getProvider(providerId);
  if (!providerReady(env, p)) throw new CalendarError(`${providerId} calendar is not configured on this deployment`);
  return p.authUrl(env, redirectUri, state);
}

/** Completes the OAuth callback: exchanges the code and stores the connection. */
export async function connect(env: Env, providerId: string, businessType: string, code: string, redirectUri: string): Promise<void> {
  const p = getProvider(providerId);
  if (!providerReady(env, p)) throw new CalendarError(`${providerId} calendar is not configured on this deployment`);
  const tok = await p.exchangeCode(env, code, redirectUri);

  const existing = await getConnection(env, businessType);
  // Reconnecting the same account keeps the chosen calendar and settings; a
  // different account (or provider) starts on its primary calendar.
  const same = existing && existing.provider === p.id && existing.accountEmail === tok.accountEmail;
  const now = new Date();
  const values = {
    businessType,
    provider: p.id,
    accountEmail: tok.accountEmail,
    calendarId: same ? existing.calendarId : 'primary',
    calendarName: same ? existing.calendarName : (tok.accountEmail ?? 'Primary'),
    refreshTokenEnc: await encryptSecret(tok.refreshToken, env.CALENDAR_TOKEN_KEY!),
    checkBusy: existing?.checkBusy ?? true,
    writeEvents: existing?.writeEvents ?? true,
    status: 'active',
    lastError: null,
    updatedAt: now,
  };
  await getDb(env.DB).insert(calendarConnections).values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: calendarConnections.businessType, set: values });
  await cacheAccessToken(env, businessType, tok.accessToken, tok.expiresIn);
}

export async function getConnection(env: Env, businessType: string): Promise<CalendarConnection | null> {
  const rows = await getDb(env.DB).select().from(calendarConnections).where(eq(calendarConnections.businessType, businessType));
  return rows[0] ?? null;
}

export async function updateConnectionSettings(
  env: Env,
  businessType: string,
  settings: Partial<Pick<CalendarConnection, 'calendarId' | 'calendarName' | 'checkBusy' | 'writeEvents'>>,
): Promise<void> {
  await getDb(env.DB).update(calendarConnections)
    .set({ ...settings, lastError: null, updatedAt: new Date() })
    .where(eq(calendarConnections.businessType, businessType));
}

/** Revokes provider access (best effort) and forgets the connection. */
export async function disconnect(env: Env, businessType: string): Promise<void> {
  const conn = await getConnection(env, businessType);
  if (!conn) return;
  const p = getProvider(conn.provider);
  if (providerReady(env, p)) {
    try {
      await p.revoke(env, await decryptSecret(conn.refreshTokenEnc, env.CALENDAR_TOKEN_KEY!));
    } catch (e: any) {
      console.error('[calendar] revoke failed', businessType, e?.message || e);
    }
  }
  await getDb(env.DB).delete(calendarConnections).where(eq(calendarConnections.businessType, businessType));
  await env.CACHE.delete(accessTokenKey(businessType));
}

async function recordError(env: Env, businessType: string, message: string, reauth = false): Promise<void> {
  await getDb(env.DB).update(calendarConnections)
    .set({ lastError: message.slice(0, 300), updatedAt: new Date(), ...(reauth ? { status: 'reauth_required' } : {}) })
    .where(eq(calendarConnections.businessType, businessType))
    .catch((e: any) => console.error('[calendar] recordError failed', e?.message || e));
}

// ── Authenticated calls ────────────────────────────────────────────────────

async function cacheAccessToken(env: Env, businessType: string, token: string, expiresIn: number): Promise<void> {
  await env.CACHE.put(accessTokenKey(businessType), token, { expirationTtl: Math.max(60, expiresIn - 120) });
}

async function accessToken(env: Env, p: CalendarProvider, conn: CalendarConnection, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.CACHE.get(accessTokenKey(conn.businessType));
    if (cached) return cached;
  }
  try {
    const tok = await p.refreshAccessToken(env, await decryptSecret(conn.refreshTokenEnc, env.CALENDAR_TOKEN_KEY!));
    await cacheAccessToken(env, conn.businessType, tok.accessToken, tok.expiresIn);
    return tok.accessToken;
  } catch (e: any) {
    // The business revoked access or the grant expired — nothing works
    // until they reconnect, so flag it for the admin UI.
    if (e instanceof CalendarError && e.reauth) {
      await recordError(env, conn.businessType, `${p.displayName} access was revoked or expired — reconnect the calendar`, true);
    }
    throw e;
  }
}

/** Runs `fn` with a valid access token, refreshing once on a 401. */
async function withToken<T>(env: Env, conn: CalendarConnection, fn: (p: CalendarProvider, token: string) => Promise<T>): Promise<T> {
  const p = getProvider(conn.provider);
  if (!providerReady(env, p)) throw new CalendarError(`${conn.provider} calendar is not configured on this deployment`);
  try {
    return await fn(p, await accessToken(env, p, conn));
  } catch (e) {
    if (!(e instanceof CalendarError && e.status === 401)) throw e;
    return fn(p, await accessToken(env, p, conn, true));
  }
}

export async function listCalendars(env: Env, conn: CalendarConnection): Promise<CalendarInfo[]> {
  return withToken(env, conn, (p, t) => p.listCalendars(t));
}

// ── Booking-facing helpers — never throw ───────────────────────────────────

function usable(env: Env, conn: CalendarConnection | null): conn is CalendarConnection {
  return !!conn && conn.status === 'active' && providerReady(env, getProvider(conn.provider));
}

/**
 * Busy intervals for the next ~2 weeks, for check_availability.
 * [] when the business has no calendar (or busy checks are off);
 * null when the calendar couldn't be reached — the caller offers D1-only
 * slots and may retry on a later turn.
 */
export async function getCalendarBusy(env: Env, businessType: string): Promise<BusyInterval[] | null> {
  if (!env.CALENDAR_TOKEN_KEY) return [];
  try {
    const conn = await getConnection(env, businessType);
    if (!usable(env, conn) || !conn.checkBusy) return [];
    const now = Date.now();
    return await withToken(env, conn, (p, t) =>
      p.freeBusy(t, conn.calendarId, new Date(now), new Date(now + BUSY_HORIZON_MS), BUSY_TIMEOUT_MS));
  } catch (e: any) {
    console.error('[calendar] busy lookup failed', businessType, e?.message || e);
    if (e?.name !== 'TimeoutError') await recordError(env, businessType, e?.message ?? String(e));
    return null;
  }
}

export function overlapsBusy(start: number, end: number, busy: BusyInterval[]): boolean {
  return busy.some(b => start < b.end && end > b.start);
}

/** Wall-clock booking → [start, end) instants. */
export function bookingInterval(scheduledAt: string, durationMinutes: number, timeZone: string | undefined): { start: Date; end: Date } {
  const start = toInstant(scheduledAt, timeZone);
  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}

/** Booking-time re-check of one slot. Fails open: an unreachable calendar never blocks a booking. */
export async function isSlotFreeInCalendar(env: Env, businessType: string, start: Date, end: Date): Promise<boolean> {
  if (!env.CALENDAR_TOKEN_KEY) return true;
  try {
    const conn = await getConnection(env, businessType);
    if (!usable(env, conn) || !conn.checkBusy) return true;
    const busy = await withToken(env, conn, (p, t) => p.freeBusy(t, conn.calendarId, start, end, SLOT_CHECK_TIMEOUT_MS));
    return !overlapsBusy(start.getTime(), end.getTime(), busy);
  } catch (e: any) {
    console.error('[calendar] slot check failed', businessType, e?.message || e);
    return true;
  }
}

// orders.calendar_event_id is "<provider>|<calendarId>|<eventId>" so a
// cancellation still finds the event after the business switches calendars.
const SEP = '|';

/** Creates the calendar event for a new booking and records the outcome on the order. */
export async function syncBookingToCalendar(env: Env, order: Order, meta: SectorMeta | null | undefined, durationMinutes: number): Promise<void> {
  if (!order.scheduledAt || !env.CALENDAR_TOKEN_KEY) return;
  const conn = await getConnection(env, order.businessType).catch(() => null);
  if (!usable(env, conn) || !conn.writeEvents) return;

  const db = getDb(env.DB);
  const timeZone = meta?.timezone || 'UTC';
  const { start, end } = bookingInterval(order.scheduledAt, durationMinutes, timeZone);
  const isLocal = !/(Z|[+-]\d{2}:\d{2})$/.test(order.scheduledAt);
  const localStart = order.scheduledAt.slice(0, 19).padEnd(19, ':00');
  const price = order.priceCents === 0 ? 'Free' : `$${(order.priceCents / 100).toFixed(2)}`;
  try {
    const eventId = await withToken(env, conn, (p, t) => p.createEvent(t, conn.calendarId, {
      title: order.productName,
      description: ['Booked by phone through Mogi.', `Reference: ${order.id.slice(0, 8)}`, `Price: ${price}`, `Payment: ${order.paymentMethod}`].join('\n'),
      start, end, timeZone,
      ...(isLocal ? { localStart, localEnd: addMinutesLocal(localStart, durationMinutes) } : {}),
      externalId: order.id,
    }, WRITE_TIMEOUT_MS));
    await db.update(ordersTable)
      .set({ calendarEventId: [conn.provider, conn.calendarId, eventId].join(SEP), calendarSync: 'synced' })
      .where(eq(ordersTable.id, order.id));
  } catch (e: any) {
    console.error('[calendar] event create failed', order.id, e?.message || e);
    await db.update(ordersTable).set({ calendarSync: 'failed' }).where(eq(ordersTable.id, order.id)).catch(() => {});
    await recordError(env, order.businessType, `Couldn't add booking ${order.id.slice(0, 8)} to the calendar: ${e?.message ?? e}`);
  }
}

export function parseEventRef(ref: string): { provider: string; calendarId: string; eventId: string } | null {
  const first = ref.indexOf(SEP);
  const last = ref.lastIndexOf(SEP);
  if (first < 0 || first === last) return null;
  return { provider: ref.slice(0, first), calendarId: ref.slice(first + 1, last), eventId: ref.slice(last + 1) };
}

/** Deletes a cancelled booking's calendar event, if it has one. */
export async function removeBookingFromCalendar(env: Env, order: Order): Promise<void> {
  const ref = order.calendarEventId ? parseEventRef(order.calendarEventId) : null;
  if (!ref || !env.CALENDAR_TOKEN_KEY) return;
  const conn = await getConnection(env, order.businessType).catch(() => null);
  // Event belongs to a since-replaced connection — no token to delete it with.
  if (!usable(env, conn) || conn.provider !== ref.provider) return;
  try {
    await withToken(env, conn, (p, t) => p.deleteEvent(t, ref.calendarId, ref.eventId, WRITE_TIMEOUT_MS));
  } catch (e: any) {
    console.error('[calendar] event delete failed', order.id, e?.message || e);
    await recordError(env, order.businessType, `Couldn't remove cancelled booking ${order.id.slice(0, 8)} from the calendar: ${e?.message ?? e}`);
  }
}
