// Business-initiated WhatsApp: booking confirmations and cancellations,
// 24-hour appointment reminders and missed-call follow-ups, each sent as an
// APPROVED utility template (whatsapp-templates.ts) and falling back to SMS
// (or skipped and logged) when there is none. Plus the durable opt-out /
// consent record every one of them checks first.
//
// Meta's rules on business-initiated messages, as applied here:
// - Only to people who opted in: a customer who wrote to the business on
//   WhatsApp, or who booked (reminders and confirmations are about their own
//   booking). The owner turns each kind on in Settings → WhatsApp and is told
//   to mention WhatsApp messages to callers.
// - Outside the 24-hour customer-service window: an approved template only.
//   Inside it, the same words as free-form text (no template charge).
// - Opt-out ("STOP", "बंद करो", …) is honoured on every channel, SMS too,
//   for that business, until the customer sends START.
// - Rate: one missed-call follow-up per customer per business per 7 days.

import type { Env, SectorMeta } from '../types';
import { customerHashSalt } from '../config';
import { hashId } from '../utils/identity';
import { getSector } from './sector.service';
import { resolveVoiceSettings } from './voice-language';
import { sendSms, smsConfigured } from './sms';
import {
  isOptedOut, lastInbound, sendTemplate, sendText, setOptedOut, whatsappNumberOf, withinServiceWindow, type ReplyLanguage,
} from './whatsapp-api';
import { defaultFor, fillTemplate, resolveTemplate, type WaEvent } from './whatsapp-templates';

// ── Consent ──────────────────────────────────────────────────────────────────

export type ConsentAction = 'opt_in' | 'opt_out';

export async function latestConsent(env: Env, businessType: string, phoneHash: string): Promise<ConsentAction | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT action FROM messaging_consent WHERE customer_id_hashed = ? AND business_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).bind(phoneHash, businessType).first<{ action: ConsentAction }>();
    return row?.action ?? null;
  } catch { return null; }
}

/** Appends to the consent history and updates the fast KV flag. */
export async function recordMessagingConsent(
  env: Env, opts: { businessType: string; phoneHash: string; action: ConsentAction; source: string; channel?: string },
): Promise<void> {
  await env.DB.prepare(`INSERT INTO messaging_consent (id, business_type, customer_id_hashed, action, source, channel, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), opts.businessType, opts.phoneHash, opts.action, opts.source.slice(0, 60), opts.channel ?? 'whatsapp', Date.now())
    .run().catch((e: any) => console.error('[wa] consent write failed', e?.message || e));
  await setOptedOut(env, opts.phoneHash, opts.action === 'opt_out', opts.businessType);
}

/** True when this customer has opted out of this business's messages (KV fast path, D1 record). */
export async function optedOut(env: Env, businessType: string, phoneHash: string): Promise<boolean> {
  if (await isOptedOut(env, phoneHash, businessType)) return true;
  return (await latestConsent(env, businessType, phoneHash)) === 'opt_out';
}

// ── Per-business switches ────────────────────────────────────────────────────

export interface WaBusinessSettings { reminders: boolean; missedCallFollowup: boolean }

export async function getBusinessSettings(env: Env, businessType: string): Promise<WaBusinessSettings> {
  const row = await env.DB.prepare('SELECT reminders, missed_call_followup FROM wa_business_settings WHERE business_type = ?')
    .bind(businessType).first<{ reminders: number; missed_call_followup: number }>().catch(() => null);
  return { reminders: !!row?.reminders, missedCallFollowup: !!row?.missed_call_followup };
}

export async function setBusinessSettings(env: Env, businessType: string, patch: Partial<WaBusinessSettings>): Promise<WaBusinessSettings> {
  const next = { ...(await getBusinessSettings(env, businessType)), ...patch };
  await env.DB.prepare(`INSERT INTO wa_business_settings (business_type, reminders, missed_call_followup, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (business_type) DO UPDATE SET reminders = excluded.reminders, missed_call_followup = excluded.missed_call_followup, updated_at = excluded.updated_at`)
    .bind(businessType, next.reminders ? 1 : 0, next.missedCallFollowup ? 1 : 0, Date.now()).run();
  return next;
}

// ── Wording ──────────────────────────────────────────────────────────────────

/** "Mon, 18 Nov, 10:30 am" from a business-local wall-clock time; "tomorrow, 10:30 am" when it is. */
export function formatWhen(scheduledAt: string, lang: ReplyLanguage, todayYmd?: string): string {
  const d = new Date(`${scheduledAt.slice(0, 16)}:00Z`);
  if (Number.isNaN(d.getTime())) return scheduledAt;
  const locale = lang === 'hi' ? 'hi-IN' : 'en-IN';
  const time = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(d);
  if (todayYmd) {
    const tomorrow = new Date(Date.parse(`${todayYmd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const ymd = scheduledAt.slice(0, 10);
    const word = ymd === todayYmd ? { en: 'today', hi: 'आज', 'hi-en': 'aaj' } : ymd === tomorrow ? { en: 'tomorrow', hi: 'कल', 'hi-en': 'kal' } : null;
    if (word) return `${word[lang]}, ${time}`;
  }
  const day = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day}, ${time}`;
}

/** Wall-clock "YYYY-MM-DDTHH:MM" of an instant in a timezone. */
export function wallClock(at: Date, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const langOf = (meta: SectorMeta | null | undefined): ReplyLanguage => resolveVoiceSettings(meta).language as ReplyLanguage;

/** What each message would say for this business (owner Settings preview), in its language. */
export function previews(meta: SectorMeta | null | undefined, businessName: string): Record<WaEvent, string> {
  const lang = langOf(meta);
  const sample = { en: 'Consultation', hi: 'परामर्श', 'hi-en': 'Consultation' }[lang];
  const when = formatWhen('2026-11-18T10:30', lang, '2026-11-17');
  const p3 = [businessName, sample, when];
  return {
    confirmation: fillTemplate(defaultFor('confirmation').body[lang], p3),
    reminder: fillTemplate(defaultFor('reminder').body[lang], p3),
    cancellation: fillTemplate(defaultFor('cancellation').body[lang], [businessName, sample, formatWhen('2026-11-18T10:30', lang)]),
    missed_call: fillTemplate(defaultFor('missed_call').body[lang], [businessName]),
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

export type SendOutcome = 'whatsapp' | 'whatsapp_text' | 'sms' | `skipped:${string}`;

/**
 * One business-initiated message about `event`: the approved template on
 * the business's WhatsApp number (free-form text if the customer is inside
 * the 24-hour window), else SMS when `smsText` is given and SMS is set up,
 * else skipped and logged. Never throws.
 */
export async function sendEventMessage(env: Env, opts: {
  event: WaEvent; businessType: string; phone: string; params: string[]; lang: ReplyLanguage; smsText?: string; phoneHash?: string;
}): Promise<SendOutcome> {
  const tag = `[wa:${opts.event}:${opts.businessType}]`;
  try {
    const to = opts.phone.replace(/\D/g, '');
    if (to.length < 8) return 'skipped:no_phone';
    const phoneHash = opts.phoneHash ?? await hashId(to, customerHashSalt(env));
    if (await optedOut(env, opts.businessType, phoneHash)) {
      console.log(`${tag} customer opted out; not sending`);
      return 'skipped:opted_out';
    }
    const pnid = env.WA_ACCESS_TOKEN ? await whatsappNumberOf(env, opts.businessType) : null;
    if (pnid) {
      const last = await lastInbound(env, phoneHash);
      const template = await resolveTemplate(env, opts.event, opts.lang);
      if (template) {
        const params = opts.params.slice(0, template.paramCount);
        if (withinServiceWindow(last?.at) && template.body) {
          if (await sendText(env, last?.pnid || pnid, to, fillTemplate(template.body, params))) return 'whatsapp_text';
        } else if (await sendTemplate(env, pnid, to, template.name, template.language, params)) {
          return 'whatsapp';
        }
      } else {
        console.log(`${tag} no approved template for this event; ${opts.smsText ? 'falling back to SMS' : 'skipping'}`);
      }
    }
    if (opts.smsText && smsConfigured(env)) {
      await sendSms(env, opts.phone.startsWith('+') ? opts.phone : `+${to}`, opts.smsText);
      return 'sms';
    }
    console.log(`${tag} not sent: ${pnid ? 'no approved template' : 'no WhatsApp number'} and no SMS fallback`);
    return pnid ? 'skipped:no_template' : 'skipped:no_channel';
  } catch (e: any) {
    console.error(`${tag} send failed`, e?.message || e);
    return 'skipped:error';
  }
}

// ── Appointment reminders (cron, hourly) ─────────────────────────────────────

/** Reminders go out for bookings starting between these many hours from now. */
export const REMINDER_WINDOW = { minHours: 2, maxHours: 24 };
/** A booking made less than this long before it starts gets no reminder (it just got a confirmation). */
export const REMINDER_MIN_LEAD_HOURS = 12;
export const REMINDER_BATCH = 200;

export interface ReminderResult { businessType: string; orderId: string; outcome: SendOutcome }

/**
 * Sends one reminder per booking, 2–24 hours before it, for businesses with
 * reminders on. Run hourly, so a reminder lands ~23–24 h before; a missed
 * run is caught up by the next. Bookings are claimed (reminder_sent_at set)
 * before sending, so overlapping runs never double-send.
 */
export async function runReminders(env: Env, now = new Date()): Promise<ReminderResult[]> {
  const out: ReminderResult[] = [];
  const { results: on } = await env.DB.prepare('SELECT business_type FROM wa_business_settings WHERE reminders = 1')
    .all<{ business_type: string }>().catch(() => ({ results: [] as { business_type: string }[] }));
  for (const { business_type: businessType } of on ?? []) {
    if (out.length >= REMINDER_BATCH) break;
    const meta = await getSector(env, businessType);
    if (!meta) continue;
    const tz = meta.timezone || 'UTC';
    const from = wallClock(new Date(now.getTime() + REMINDER_WINDOW.minHours * 3_600_000), tz);
    const to = wallClock(new Date(now.getTime() + REMINDER_WINDOW.maxHours * 3_600_000), tz);
    const { results: due } = await env.DB.prepare(`SELECT id, product_name, scheduled_at, callback_phone, customer_id_hashed, created_at FROM orders
        WHERE business_type = ? AND scheduled_at > ? AND scheduled_at <= ? AND status != 'CANCELLED'
          AND reminder_sent_at IS NULL AND callback_phone IS NOT NULL
        ORDER BY scheduled_at LIMIT ?`)
      .bind(businessType, from, `${to}:59`, REMINDER_BATCH - out.length)
      .all<{ id: string; product_name: string; scheduled_at: string; callback_phone: string; customer_id_hashed: string; created_at: number }>();
    const lang = langOf(meta);
    const today = wallClock(now, tz).slice(0, 10);
    for (const o of due ?? []) {
      // Claim it first: a second run (or a retry) skips it.
      const claim = await env.DB.prepare('UPDATE orders SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL').bind(Date.now(), o.id).run();
      if (!claim.meta?.changes) continue;
      const createdLocal = wallClock(new Date(Number(o.created_at) * 1000), tz);
      const leadLimit = new Date(Date.parse(`${o.scheduled_at.slice(0, 16)}:00Z`) - REMINDER_MIN_LEAD_HOURS * 3_600_000).toISOString().slice(0, 16);
      let outcome: SendOutcome;
      if (o.customer_id_hashed.startsWith('synthetic-')) outcome = 'skipped:synthetic';
      else if (createdLocal > leadLimit) outcome = 'skipped:booked_recently';
      else {
        const when = formatWhen(o.scheduled_at, lang, today);
        const params = [meta.name, o.product_name, when];
        outcome = await sendEventMessage(env, {
          event: 'reminder', businessType, phone: o.callback_phone, params, lang,
          smsText: `${meta.name}: reminder, your ${o.product_name} is ${formatWhen(o.scheduled_at, 'en', today)}.${meta.phone ? ` To change it call ${meta.phone}.` : ''} Reply STOP to opt out.`,
        });
      }
      await env.DB.prepare('UPDATE orders SET reminder_channel = ? WHERE id = ?').bind(outcome, o.id).run();
      out.push({ businessType, orderId: o.id, outcome });
    }
  }
  return out;
}

// ── Missed-call follow-up ────────────────────────────────────────────────────

export type FollowUpReason = 'unanswered' | 'cut_short' | 'message';

/**
 * Why a call deserves a "continue on WhatsApp" message, or null:
 * a message was taken; the caller said nothing (hung up during the
 * greeting); or the call ended with the caller's words unanswered or under
 * 20 seconds. Never after a booking or a transfer to staff.
 */
export function followUpReason(c: {
  userTurns: number; lastRole: 'user' | 'assistant' | null; durationSec: number; messageTaken: boolean; transferred: boolean; booked: boolean;
}): FollowUpReason | null {
  if (c.transferred || c.booked) return null;
  if (c.messageTaken) return 'message';
  if (c.userTurns === 0) return 'unanswered';
  if (c.lastRole === 'user' || c.durationSec < 20) return 'cut_short';
  return null;
}

export const FOLLOWUP_COOLDOWN_SECONDS = 7 * 86400;

export async function missedCallFollowUp(env: Env, opts: {
  businessType: string; callSid: string; callerPhone?: string | null; phoneHash: string; startedAtSec: number;
  userTurns: number; lastRole: 'user' | 'assistant' | null; durationSec: number; messageTaken: boolean; transferred: boolean;
}): Promise<SendOutcome | 'off' | 'not_needed'> {
  if (!opts.callerPhone || opts.phoneHash.startsWith('synthetic-')) return 'not_needed';
  if (!(await getBusinessSettings(env, opts.businessType)).missedCallFollowup) return 'off';
  const booked = !!(await env.DB.prepare('SELECT 1 FROM orders WHERE customer_id_hashed = ? AND business_type = ? AND created_at >= ? LIMIT 1')
    .bind(opts.phoneHash, opts.businessType, opts.startedAtSec - 5).first().catch(() => null));
  const reason = followUpReason({ ...opts, booked });
  if (!reason) return 'not_needed';
  const callKey = `wa:fu:call:${opts.callSid}`;
  const custKey = `wa:fu:${opts.businessType}:${opts.phoneHash}`;
  if (await env.CACHE.get(callKey) || await env.CACHE.get(custKey)) return 'skipped:recent';
  await env.CACHE.put(callKey, '1', { expirationTtl: 86400 });
  const meta = await getSector(env, opts.businessType);
  const outcome = await sendEventMessage(env, {
    event: 'missed_call', businessType: opts.businessType, phone: opts.callerPhone, phoneHash: opts.phoneHash,
    params: [meta?.name ?? opts.businessType], lang: langOf(meta),
  });
  if (outcome === 'whatsapp' || outcome === 'whatsapp_text') await env.CACHE.put(custKey, '1', { expirationTtl: FOLLOWUP_COOLDOWN_SECONDS });
  console.log(`[wa:missed_call:${opts.businessType}] ${reason}: ${outcome}`);
  return outcome;
}
