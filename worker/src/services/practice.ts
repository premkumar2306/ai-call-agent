// Practice software (launch item 6): the safe path that works with Practo,
// Clinicia, Eka or a paper diary alike.
//
// 1. Front-desk confirmation mode (per business, off by default): Avery takes
//    the booking request, the patient is told it is PENDING until the clinic
//    confirms, and the front desk gets a link (SMS, or WhatsApp text inside
//    the 24-hour window, plus email) with one-tap Confirm or Suggest another
//    time. The link page is GET-only and changes nothing; the buttons POST,
//    so link previews never confirm a booking.
// 2. Read-only availability import from an iCalendar (ICS) feed, per business,
//    off by default: busy times block slots exactly like Google Calendar's.
//    Nothing is written back to the practice software.
//
// No vendor API is called: see docs/practice-software.md for what each
// vendor documents publicly.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { practiceSettings } from '../db/schema';
import type { Env, SectorMeta } from '../types';
import { toInstant } from '../utils/time';
import { normalizeE164 } from './phone-numbers';
import { sendEmail } from './notify.service';
import { sendSms, smsConfigured } from './sms';
import type { BusyInterval } from './calendar/types';

export type PracticeSettings = typeof practiceSettings.$inferSelect;
export const SOFTWARE = ['practo', 'clinicia', 'eka', 'other', 'none'] as const;

const nowSec = () => Math.floor(Date.now() / 1000);
const ICS_KEY = (bt: string) => `ics:busy:${bt}`;
export const ICS_HORIZON_DAYS = 14;
export const ICS_MAX_BYTES = 2_000_000;

export async function getPracticeSettings(env: Env, businessType: string): Promise<PracticeSettings | null> {
  try {
    const [row] = await getDb(env.DB).select().from(practiceSettings).where(eq(practiceSettings.businessType, businessType));
    return row ?? null;
  } catch { return null; }
}

export interface PracticeInput {
  software?: string | null; confirmationMode?: boolean; frontDeskPhone?: string | null; icsImport?: boolean; icsUrl?: string | null;
}

export function validatePracticeInput(b: any): PracticeInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const out: PracticeInput = {};
  if (b.software !== undefined) {
    if (b.software !== null && !(SOFTWARE as readonly string[]).includes(b.software)) return `software must be one of ${SOFTWARE.join(', ')}`;
    out.software = b.software;
  }
  for (const k of ['confirmationMode', 'icsImport'] as const) {
    if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') return `${k} must be true or false`; out[k] = b[k]; }
  }
  if (b.frontDeskPhone !== undefined) {
    if (b.frontDeskPhone === null || b.frontDeskPhone === '') out.frontDeskPhone = null;
    else {
      const p = normalizeE164(String(b.frontDeskPhone), '91');
      if (!p) return 'Front desk phone must be a phone number, e.g. +91 98450 12345';
      out.frontDeskPhone = p;
    }
  }
  if (b.icsUrl !== undefined) {
    if (b.icsUrl === null || b.icsUrl === '') out.icsUrl = null;
    else {
      let u: URL;
      try { u = new URL(String(b.icsUrl).trim().replace(/^webcal:/i, 'https:')); } catch { return 'Calendar link must be an https:// or webcal:// address'; }
      if (u.protocol !== 'https:') return 'Calendar link must be an https:// or webcal:// address';
      out.icsUrl = u.toString();
    }
  }
  return out;
}

export async function savePracticeSettings(env: Env, businessType: string, p: PracticeInput): Promise<PracticeSettings> {
  const cur = await getPracticeSettings(env, businessType);
  const next = {
    software: cur?.software ?? null, confirmationMode: cur?.confirmationMode ?? false, frontDeskPhone: cur?.frontDeskPhone ?? null,
    icsImport: cur?.icsImport ?? false, icsUrl: cur?.icsUrl ?? null, ...p,
  };
  if (next.confirmationMode && !next.frontDeskPhone) throw Object.assign(new Error('Add the front desk phone number first'), { status: 400 });
  if (next.icsImport && !next.icsUrl) throw Object.assign(new Error('Add the calendar (ICS) link first'), { status: 400 });
  const now = nowSec();
  await getDb(env.DB).insert(practiceSettings).values({ businessType, ...next, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: practiceSettings.businessType, set: { ...next, updatedAt: now } });
  if (!next.icsImport) await env.CACHE.delete(ICS_KEY(businessType));
  return (await getPracticeSettings(env, businessType))!;
}

/** Owner-facing view: the ICS link is shown masked (it often carries a private token). */
export function publicSettings(s: PracticeSettings | null) {
  return {
    software: s?.software ?? null, confirmationMode: s?.confirmationMode ?? false, frontDeskPhone: s?.frontDeskPhone ?? null,
    icsImport: s?.icsImport ?? false, icsUrlSet: !!s?.icsUrl, icsUrlHost: s?.icsUrl ? new URL(s.icsUrl).host : null,
    icsLastSync: s?.icsLastSync ?? null, icsLastError: s?.icsLastError ?? null, icsBusyCount: s?.icsBusyCount ?? null,
  };
}

// ── Front-desk confirmation ─────────────────────────────────────────────────

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
/** The Worker's public base for front-desk links. */
const workerUrl = (env: Env, base?: string) => (base ?? env.WORKER_URL ?? env.PLIVO_WEBHOOK_URL ?? env.TWILIO_WEBHOOK_URL ?? '').replace(/\/$/, '');

export function pendingSpokenResponse(service: string, when: string): string {
  return `I've sent your request for ${service}${when} to the clinic. It's pending until the front desk confirms it — you'll get a message as soon as they do. Anything else I can help with?`;
}

/** Marks a new booking as waiting for the front desk and sends them the link. Never throws. */
export async function requestFrontDeskConfirmation(env: Env, meta: SectorMeta | null | undefined, order: { id: string; productName: string; scheduledAt?: string | null; customerName?: string | null; callbackPhone?: string | null; businessType: string }, linkBase?: string): Promise<string> {
  try {
    const s = await getPracticeSettings(env, order.businessType);
    const t = token();
    await env.DB.prepare(`UPDATE orders SET front_desk_status = 'pending', front_desk_token = ? WHERE id = ?`).bind(t, order.id).run();
    const link = `${workerUrl(env, linkBase)}/fd/${t}`;
    const who = `${order.customerName ?? 'A patient'}${order.callbackPhone ? ` (${order.callbackPhone})` : ''}`;
    const when = order.scheduledAt ? ` on ${order.scheduledAt.slice(0, 16).replace('T', ' at ')}` : '';
    const text = `${meta?.name ?? 'Clinic'}: booking request from ${who} for ${order.productName}${when}. Confirm or suggest another time: ${link}`;
    const sent: string[] = [];
    if (s?.frontDeskPhone && smsConfigured(env)) { await sendSms(env, s.frontDeskPhone, text); sent.push('sms'); }
    if (meta?.notifyEmail) { await sendEmail(env, meta.notifyEmail, `Please confirm: ${order.productName}${when}`, `${text}\n\nThe patient has been told the booking is pending until you confirm.\n`); sent.push('email'); }
    // The patient hears "pending" on the call; a text too, when SMS is set up.
    if (order.callbackPhone && smsConfigured(env)) {
      await sendSms(env, order.callbackPhone, `${meta?.name ?? 'Clinic'}: we've received your request for ${order.productName}${when}. It's pending until the clinic confirms; we'll message you. Reply STOP to opt out.`);
    }
    return sent.join('+') || 'none';
  } catch (e: any) {
    console.error('[practice] front-desk request failed', order.id, e?.message || e);
    return 'error';
  }
}

export type FrontDeskOrder = { id: string; business_type: string; product_name: string; scheduled_at: string | null; customer_name: string | null; callback_phone: string | null; status: string; front_desk_status: string | null; suggested_at: string | null };

export async function orderForToken(env: Env, t: string): Promise<FrontDeskOrder | null> {
  if (!/^[0-9a-f]{48}$/.test(t)) return null;
  return await env.DB.prepare(`SELECT id, business_type, product_name, scheduled_at, customer_name, callback_phone, status, front_desk_status, suggested_at
      FROM orders WHERE front_desk_token = ?`).bind(t).first<FrontDeskOrder>() ?? null;
}

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Front desk confirms: the booking is confirmed and the patient gets the normal confirmation. */
export async function confirmByFrontDesk(env: Env, t: string): Promise<FrontDeskOrder | null> {
  const o = await orderForToken(env, t);
  if (!o || o.status === 'CANCELLED') return null;
  if (o.front_desk_status === 'confirmed') return o;
  await env.DB.prepare(`UPDATE orders SET status = 'CONFIRMED', front_desk_status = 'confirmed', updated_at = ? WHERE id = ?`).bind(nowSec(), o.id).run();
  return { ...o, status: 'CONFIRMED', front_desk_status: 'confirmed' };
}

/** Front desk suggests another time; the patient is asked to reply or call. */
export async function suggestByFrontDesk(env: Env, meta: SectorMeta | null | undefined, t: string, at: string): Promise<FrontDeskOrder | string> {
  const o = await orderForToken(env, t);
  if (!o || o.status === 'CANCELLED') return 'This request is no longer open';
  if (!LOCAL_RE.test(at)) return 'Pick a date and time';
  if (toInstant(`${at}:00`, meta?.timezone).getTime() < Date.now()) return 'That time has passed';
  await env.DB.prepare(`UPDATE orders SET front_desk_status = 'suggested', suggested_at = ?, updated_at = ? WHERE id = ?`).bind(at, nowSec(), o.id).run();
  if (o.callback_phone && smsConfigured(env)) {
    await sendSms(env, o.callback_phone, `${meta?.name ?? 'Clinic'}: the clinic can't do your requested time for ${o.product_name}. They suggest ${at.replace('T', ' at ')}. ` +
      `Reply or call${meta?.phone ? ` ${meta.phone}` : ' us'} to confirm. Reply STOP to opt out.`).catch(() => {});
  }
  return { ...o, front_desk_status: 'suggested', suggested_at: at };
}

// ── ICS import (read-only) ──────────────────────────────────────────────────

/** Unfolds RFC 5545 content lines (a line starting with space/tab continues the previous one). */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function icsTime(value: string, params: string, defaultTz: string): { at: number; allDay: boolean } | null {
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1];
  if (/VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return m ? { at: toInstant(`${m[1]}-${m[2]}-${m[3]}T00:00:00`, tzid ?? defaultTz).getTime(), allDay: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return { at: m[7] ? Date.parse(`${local}Z`) : toInstant(local, tzid ?? defaultTz).getTime(), allDay: false };
}

/**
 * Busy intervals from an ICS feed: VEVENTs with DTSTART and DTEND (or
 * DURATION in hours/minutes, or all-day). Cancelled and "free" (TRANSPARENT)
 * events are skipped. Recurring events (RRULE) count only their first
 * occurrence; see docs/practice-software.md.
 */
export function parseIcs(text: string, defaultTz: string, from: number, to: number): BusyInterval[] {
  const out: BusyInterval[] = [];
  let ev: Record<string, { v: string; p: string }> | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT' && ev) {
      const s = ev.DTSTART && icsTime(ev.DTSTART.v, ev.DTSTART.p, defaultTz);
      let end: number | null = null;
      if (ev.DTEND) { const e = icsTime(ev.DTEND.v, ev.DTEND.p, defaultTz); end = e?.at ?? null; }
      else if (s && ev.DURATION) {
        const d = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(ev.DURATION.v);
        if (d) end = s.at + ((+(d[1] ?? 0) * 24 + +(d[2] ?? 0)) * 60 + +(d[3] ?? 0)) * 60_000;
      } else if (s?.allDay) end = s.at + 86_400_000;
      const skip = ev.STATUS?.v.toUpperCase() === 'CANCELLED' || ev.TRANSP?.v.toUpperCase() === 'TRANSPARENT';
      if (s && end && end > s.at && !skip && s.at < to && end > from) out.push({ start: s.at, end });
      ev = null;
      continue;
    }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    ev[name.toUpperCase()] = { v: line.slice(i + 1).trim(), p: params.join(';') };
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Fetches the feed and caches the next 14 days of busy times in KV. */
export async function syncIcs(env: Env, businessType: string, tz = 'Asia/Kolkata'): Promise<{ ok: boolean; busy: number; error?: string }> {
  const s = await getPracticeSettings(env, businessType);
  if (!s?.icsImport || !s.icsUrl) return { ok: false, busy: 0, error: 'ICS import is off' };
  let result: { ok: boolean; busy: number; error?: string };
  try {
    const res = await fetch(s.icsUrl, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`The calendar link answered ${res.status}`);
    const text = await res.text();
    if (text.length > ICS_MAX_BYTES) throw new Error('The calendar feed is too large (over 2 MB)');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link is not an iCalendar (ICS) feed');
    const now = Date.now();
    const busy = parseIcs(text, tz, now - 3_600_000, now + ICS_HORIZON_DAYS * 86_400_000);
    await env.CACHE.put(ICS_KEY(businessType), JSON.stringify(busy), { expirationTtl: 3 * 3600 });
    result = { ok: true, busy: busy.length };
  } catch (e: any) {
    result = { ok: false, busy: 0, error: String(e?.message || e).slice(0, 200) };
  }
  await getDb(env.DB).update(practiceSettings).set({
    icsLastSync: nowSec(), icsLastError: result.error ?? null, ...(result.ok ? { icsBusyCount: result.busy } : {}), updatedAt: nowSec(),
  }).where(eq(practiceSettings.businessType, businessType));
  return result;
}

/** Imported busy times for a business (empty when the import is off or not synced yet). */
export async function icsBusy(env: Env, businessType: string): Promise<BusyInterval[]> {
  try {
    const raw = await env.CACHE.get(ICS_KEY(businessType));
    return raw ? JSON.parse(raw) as BusyInterval[] : [];
  } catch { return []; }
}

/** Hourly cron: refresh every business's ICS import. */
export async function runIcsSync(env: Env): Promise<Array<{ businessType: string; ok: boolean; busy: number }>> {
  const { results } = await env.DB.prepare('SELECT p.business_type, s.timezone FROM practice_settings p LEFT JOIN sectors s ON s.key = p.business_type WHERE p.ics_import = 1')
    .all<{ business_type: string; timezone: string | null }>().catch(() => ({ results: [] as { business_type: string; timezone: string | null }[] }));
  const out = [];
  for (const r of results ?? []) out.push({ businessType: r.business_type, ...(await syncIcs(env, r.business_type, r.timezone || 'Asia/Kolkata')) });
  return out;
}

