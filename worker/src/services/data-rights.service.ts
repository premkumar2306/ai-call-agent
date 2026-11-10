import type { Env, Order } from '../types';
import { hashId } from '../utils/identity';
import { customerHashSalt } from '../config';
import { toInstant } from '../utils/time';
import { removeBookingFromCalendar } from './calendar';

// Data-principal requests (India DPDP Act 2023 ss.11–12): export and erase
// everything Avery stores about one caller for one business.
//
// A caller is identified the same way calls and WhatsApp identify them: the
// HMAC of their phone number's digits (utils/identity.ts, routes/twilio.ts).
// Records that only carry the raw number (callback_phone on bookings and
// messages) are matched by E.164 too.
//
// Erasure removes personal data but keeps aggregate booking records
// (service, price, time, status) so the business's counts stay right:
//   transcripts           → deleted (D1) + live call/chat history (KV)
//   call_messages         → deleted
//   orders                → name/vehicle/phone/notes/address cleared, caller
//                           id replaced by ERASED_ID; upcoming bookings are
//                           cancelled and calendar events removed
//   consent_records       → kept as the notice audit trail, caller id cleared
//   customers             → deleted once no business holds data for them

export const ERASED_ID = 'erased';
const ACTIVE = ['PENDING', 'ACCEPTED', 'COMPLETE'];

export interface Subject {
  hash: string;
  /** "+<digits>" when identified by phone, for matching callback_phone. */
  e164: string | null;
}

/** Digits of a phone number with country code, or null if it can't be one. */
export function phoneDigits(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** From an admin request body: { phone } (with country code) or { customerIdHashed }. */
export async function resolveSubject(env: Env, body: unknown): Promise<Subject | { error: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.phone !== undefined && b.phone !== '') {
    const digits = phoneDigits(b.phone);
    if (!digits) return { error: 'phone must be a full number with country code, e.g. +91 98765 43210' };
    return { hash: await hashId(digits, customerHashSalt(env)), e164: `+${digits}` };
  }
  if (typeof b.customerIdHashed === 'string' && /^[0-9a-f]{64}$/.test(b.customerIdHashed)) {
    return { hash: b.customerIdHashed, e164: null };
  }
  return { error: 'Provide phone (with country code) or customerIdHashed' };
}

// KV keys holding a caller's live history. All expire within a day anyway
// (call history 1h, WhatsApp history 24h); erasure doesn't wait for that.
export function kvKeysFor(businessType: string, hash: string, callSids: string[]): { cart: string[]; cache: string[] } {
  return {
    cart: [
      ...callSids.flatMap(sid => [`call:${sid}`, `callmsgs:${sid}`, `clf:completed:${sid}`]),
      `wa:${hash}:${businessType}`,
      `cart:${hash}:${businessType}`,
    ],
    cache: [...callSids.map(sid => `transfer:${sid}`), `rl:wa:${hash}`],
  };
}

/** Booking fields that identify a person; cleared on erasure. */
export const ORDER_PERSONAL_COLUMNS = [
  'customer_name', 'vehicle', 'callback_phone', 'notes',
  'shipping_line1', 'shipping_city', 'shipping_state', 'shipping_zip',
] as const;

/** Upcoming, still-active booking (cancelled on erasure: nobody could be contacted about it). */
export function isUpcomingActive(order: { status: string; scheduled_at: string | null }, timeZone: string | undefined, now: Date): boolean {
  if (!ACTIVE.includes(order.status) || !order.scheduled_at) return false;
  return toInstant(order.scheduled_at, timeZone).getTime() > now.getTime();
}

const placeholders = (n: number) => Array(n).fill('?').join(', ');

async function all<T>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await env.DB.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

type Row = Record<string, unknown>;

async function findTranscripts(env: Env, businessType: string, s: Subject) {
  return all<Row & { id: string; call_sid: string | null }>(env,
    'SELECT * FROM transcripts WHERE business_type = ? AND customer_id_hashed = ? ORDER BY created_at', businessType, s.hash);
}

async function findMessages(env: Env, businessType: string, s: Subject, callSids: string[]) {
  const ors = ['customer_id_hashed = ?'];
  const params: unknown[] = [businessType, s.hash];
  if (s.e164) { ors.push('callback_phone = ?'); params.push(s.e164); }
  if (callSids.length) { ors.push(`call_sid IN (${placeholders(callSids.length)})`); params.push(...callSids); }
  return all<Row & { id: string }>(env,
    `SELECT * FROM call_messages WHERE business_type = ? AND (${ors.join(' OR ')}) ORDER BY created_at`, ...params);
}

async function findOrders(env: Env, businessType: string, s: Subject) {
  const params: unknown[] = [businessType, s.hash];
  let where = 'customer_id_hashed = ?';
  if (s.e164) { where += ' OR callback_phone = ?'; params.push(s.e164); }
  return all<Row & { id: string; status: string; scheduled_at: string | null; calendar_event_id: string | null }>(env,
    `SELECT * FROM orders WHERE business_type = ? AND (${where}) ORDER BY created_at`, ...params);
}

async function findConsent(env: Env, businessType: string, s: Subject) {
  return all<Row>(env,
    'SELECT id, channel, call_sid, notice_version, notice_text, played_at, heard_fully FROM consent_records WHERE business_type = ? AND customer_id_hashed = ? ORDER BY played_at',
    businessType, s.hash);
}

async function logRequest(env: Env, businessType: string, kind: 'export' | 'erase', hash: string, summary: unknown) {
  await env.DB.prepare('INSERT INTO data_requests (id, business_type, kind, customer_id_hashed, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), businessType, kind, hash, JSON.stringify(summary), Math.floor(Date.now() / 1000)).run();
}

const parseJson = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** Everything stored about the caller for this business (right of access, s.11). */
export async function exportSubjectData(env: Env, businessType: string, s: Subject) {
  const transcripts = await findTranscripts(env, businessType, s);
  const callSids = transcripts.map(t => t.call_sid).filter((x): x is string => !!x);
  const [messages, orders, consent, customer] = await Promise.all([
    findMessages(env, businessType, s, callSids),
    findOrders(env, businessType, s),
    findConsent(env, businessType, s),
    env.DB.prepare('SELECT id_hashed, tier, store_credit_cents, created_at FROM customers WHERE id_hashed = ?').bind(s.hash).first(),
  ]);
  const keys = kvKeysFor(businessType, s.hash, callSids);
  const live: Record<string, unknown> = {};
  for (const key of keys.cart.filter(k => k.startsWith('call:') || k.startsWith('wa:') || k.startsWith('cart:'))) {
    const v = await env.CART.get(key);
    if (v !== null) live[key] = parseJson(v);
  }
  const data = {
    businessType,
    customerIdHashed: s.hash,
    exportedAt: new Date().toISOString(),
    customer: customer ?? null,
    transcripts: transcripts.map(t => ({ ...t, turns: parseJson(t.turns), metrics: undefined })),
    liveHistory: live,
    messages,
    bookings: orders,
    noticeRecords: consent,
  };
  await logRequest(env, businessType, 'export', s.hash, {
    transcripts: transcripts.length, messages: messages.length, bookings: orders.length, noticeRecords: consent.length,
  });
  return data;
}

export interface ErasureSummary {
  transcriptsDeleted: number;
  messagesDeleted: number;
  bookingsAnonymised: number;
  upcomingBookingsCancelled: number;
  liveHistoryKeysCleared: number;
  noticeRecordsUnlinked: number;
  customerRowDeleted: boolean;
}

/** Erases the caller's personal data for this business (s.12). */
export async function eraseSubjectData(env: Env, businessType: string, s: Subject, timeZone?: string, now = new Date()): Promise<ErasureSummary> {
  const transcripts = await findTranscripts(env, businessType, s);
  const callSids = transcripts.map(t => t.call_sid).filter((x): x is string => !!x);
  const [messages, orders] = await Promise.all([
    findMessages(env, businessType, s, callSids),
    findOrders(env, businessType, s),
  ]);
  const nowSec = Math.floor(now.getTime() / 1000);
  const stmts: D1PreparedStatement[] = [];

  if (transcripts.length) {
    stmts.push(env.DB.prepare(`DELETE FROM transcripts WHERE id IN (${placeholders(transcripts.length)})`).bind(...transcripts.map(t => t.id)));
  }
  if (messages.length) {
    stmts.push(env.DB.prepare(`DELETE FROM call_messages WHERE id IN (${placeholders(messages.length)})`).bind(...messages.map(m => m.id)));
  }
  const upcoming = orders.filter(o => isUpcomingActive(o, timeZone, now));
  const upcomingIds = new Set(upcoming.map(o => o.id));
  for (const o of orders) {
    const clear = ORDER_PERSONAL_COLUMNS.map(col => `${col} = NULL`).join(', ');
    stmts.push(env.DB.prepare(
      `UPDATE orders SET ${clear}, customer_id_hashed = ?, calendar_event_id = NULL, ` +
      `status = ?, updated_at = ? WHERE id = ?`,
    ).bind(ERASED_ID, upcomingIds.has(o.id) ? 'CANCELLED' : o.status, nowSec, o.id));
  }
  stmts.push(env.DB.prepare('UPDATE consent_records SET customer_id_hashed = NULL WHERE business_type = ? AND customer_id_hashed = ?')
    .bind(businessType, s.hash));
  const results = await env.DB.batch(stmts);
  const noticeRecordsUnlinked = results[results.length - 1]?.meta?.changes ?? 0;

  // Calendar events carry the caller's name and number. After the D1 write,
  // so a calendar outage can't block the erasure itself.
  await Promise.all(orders.filter(o => o.calendar_event_id).map(o =>
    removeBookingFromCalendar(env, { id: o.id, businessType, calendarEventId: o.calendar_event_id } as Pick<Order, 'id' | 'businessType' | 'calendarEventId'>)
      .catch((e: any) => console.error('[erase] calendar event delete failed', o.id, e?.message || e))));

  const keys = kvKeysFor(businessType, s.hash, callSids);
  await Promise.all([
    ...keys.cart.map(k => env.CART.delete(k)),
    ...keys.cache.map(k => env.CACHE.delete(k)),
  ]);

  // The customers row (tier, store credit) is shared by every business the
  // caller has used: drop it only when none still holds data for them.
  const remaining = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM transcripts WHERE customer_id_hashed = ?1) +
            (SELECT COUNT(*) FROM orders WHERE customer_id_hashed = ?1) AS n`,
  ).bind(s.hash).first<{ n: number }>();
  let customerRowDeleted = false;
  if (!remaining?.n) {
    const del = await env.DB.prepare('DELETE FROM customers WHERE id_hashed = ?').bind(s.hash).run();
    customerRowDeleted = (del.meta?.changes ?? 0) > 0;
  }

  const summary: ErasureSummary = {
    transcriptsDeleted: transcripts.length,
    messagesDeleted: messages.length,
    bookingsAnonymised: orders.length,
    upcomingBookingsCancelled: upcoming.length,
    liveHistoryKeysCleared: keys.cart.length + keys.cache.length,
    noticeRecordsUnlinked,
    customerRowDeleted,
  };
  await logRequest(env, businessType, 'erase', s.hash, summary);
  return summary;
}
