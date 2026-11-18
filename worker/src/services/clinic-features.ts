// Clinic features (launch item 4). Each is a per-business switch, OFF by
// default (no clinic_features row = everything off):
//
// - duration booking: a slot is free only when fewer than `capacity` (chairs)
//   other patients' visits overlap the whole procedure, using each service's
//   duration. Doctors (resources) already book by duration and overlap.
// - recalls: N months after a completed visit (optionally only for one
//   service category), a WhatsApp/SMS asks the patient to book again, unless
//   they already have a later booking.
// - no-show recovery: after staff mark a visit "no show", a rebook message
//   goes to the patient and a "call back to rebook" task is added to the
//   clinic's messages (the follow-up call option).
// - review requests: after staff mark a visit "completed", the clinic's
//   Google review link goes to EVERY such patient. No rating is asked first
//   and nobody is filtered out by score: Google's policy forbids selectively
//   soliciting positive reviews ("review gating").
//
// Messages use the approved WhatsApp templates and the opt-out from PR #97
// (sendEventMessage checks STOP), and run from the hourly cron. Each booking
// is claimed (…_sent_at) before sending, so overlapping runs never double-send.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { callMessages, clinicFeatures } from '../db/schema';
import type { Env, SectorMeta } from '../types';
import type { ReplyLanguage } from './whatsapp-api';
import { getSector } from './sector.service';
import { resolveVoiceSettings } from './voice-language';
import { formatWhen, monthsText, sendEventMessage, wallClock, type SendOutcome } from './whatsapp-outbound';

export type ClinicFeatures = typeof clinicFeatures.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
export const CLINIC_BATCH = 200;
/** Review requests wait this long after the visit is marked completed (not mid-treatment). */
export const REVIEW_DELAY_SECONDS = 2 * 3600;
/** No messages for visits older than this when a switch is first turned on (no back-fill blast). */
export const MAX_AGE_SECONDS = 7 * 86_400;

export const OFF: Omit<ClinicFeatures, 'businessType' | 'createdAt' | 'updatedAt'> = {
  durationBooking: false, recalls: false, recallMonths: 6, recallCategory: null,
  noShowRecovery: false, reviewRequests: false, reviewUrl: null,
};

export async function getClinicFeatures(env: Env, businessType: string): Promise<ClinicFeatures | null> {
  try {
    const [row] = await getDb(env.DB).select().from(clinicFeatures).where(eq(clinicFeatures.businessType, businessType));
    return row ?? null;
  } catch { return null; }
}

export async function durationBookingOn(env: Env, businessType: string): Promise<boolean> {
  return !!(await getClinicFeatures(env, businessType))?.durationBooking;
}

export type ClinicFeaturesInput = Partial<Omit<ClinicFeatures, 'businessType' | 'createdAt' | 'updatedAt'>>;

export function validateClinicFeatures(b: any): ClinicFeaturesInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const out: ClinicFeaturesInput = {};
  for (const k of ['durationBooking', 'recalls', 'noShowRecovery', 'reviewRequests'] as const) {
    if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') return `${k} must be true or false`; out[k] = b[k]; }
  }
  if (b.recallMonths !== undefined) {
    if (!Number.isInteger(b.recallMonths) || b.recallMonths < 1 || b.recallMonths > 36) return 'recallMonths must be 1–36';
    out.recallMonths = b.recallMonths;
  }
  if (b.recallCategory !== undefined) out.recallCategory = typeof b.recallCategory === 'string' && b.recallCategory.trim() ? b.recallCategory.trim().slice(0, 60) : null;
  if (b.reviewUrl !== undefined) {
    if (b.reviewUrl === null || b.reviewUrl === '') out.reviewUrl = null;
    else if (typeof b.reviewUrl !== 'string' || !/^https:\/\/(g\.page|search\.google\.com|www\.google\.com|maps\.app\.goo\.gl|g\.co)\//.test(b.reviewUrl.trim())) {
      return 'Review link must be your Google review link (https://g.page/…, https://search.google.com/… or https://maps.app.goo.gl/…)';
    } else out.reviewUrl = b.reviewUrl.trim();
  }
  return out;
}

export async function saveClinicFeatures(env: Env, businessType: string, patch: ClinicFeaturesInput): Promise<ClinicFeatures> {
  const cur = await getClinicFeatures(env, businessType);
  const next = { ...OFF, ...(cur ?? {}), ...patch };
  if (next.reviewRequests && !next.reviewUrl) throw Object.assign(new Error('Add your Google review link first'), { status: 400 });
  const now = nowSec();
  const values = {
    durationBooking: next.durationBooking, recalls: next.recalls, recallMonths: next.recallMonths, recallCategory: next.recallCategory,
    noShowRecovery: next.noShowRecovery, reviewRequests: next.reviewRequests, reviewUrl: next.reviewUrl, updatedAt: now,
  };
  await getDb(env.DB).insert(clinicFeatures).values({ businessType, ...values, createdAt: now })
    .onConflictDoUpdate({ target: clinicFeatures.businessType, set: values });
  return (await getClinicFeatures(env, businessType))!;
}

// ── Visit outcome (staff) ───────────────────────────────────────────────────

export async function markVisit(env: Env, businessType: string, orderId: string, status: 'completed' | 'no_show' | null): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE orders SET visit_status = ?, visit_marked_at = ?, updated_at = ?
      WHERE id = ? AND business_type = ? AND status != 'CANCELLED' AND scheduled_at IS NOT NULL`)
    .bind(status, status ? nowSec() : null, nowSec(), orderId, businessType).run();
  return !!r.meta?.changes;
}

// ── Duration booking ────────────────────────────────────────────────────────

export interface Interval { start: string; end: string; customer: string } // business-local 'YYYY-MM-DDTHH:MM'

/** Upcoming bookings as intervals: ends_at if stored, else start + the service's duration (60 if unknown). */
export async function getBookedIntervals(env: Env, businessType: string, fromLocal: string): Promise<Interval[]> {
  const { results } = await env.DB.prepare(`SELECT substr(o.scheduled_at, 1, 16) AS start,
        COALESCE(substr(o.ends_at, 1, 16), strftime('%Y-%m-%dT%H:%M', substr(o.scheduled_at, 1, 16), '+' || COALESCE(p.duration_minutes, 60) || ' minutes')) AS end,
        o.customer_id_hashed AS customer
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
      WHERE o.business_type = ? AND o.status != 'CANCELLED' AND o.scheduled_at IS NOT NULL AND o.resource_id IS NULL
        AND substr(o.scheduled_at, 1, 10) >= date(?, '-1 day')`)
    // From the day before: a long visit that started earlier can still overlap the first slot.
    .bind(businessType, fromLocal.slice(0, 10)).all<Interval>();
  return results ?? [];
}

/** Distinct other patients whose visit overlaps [start, end). */
export function overlappingPatients(intervals: Interval[], start: string, end: string, self?: string): number {
  const who = new Set<string>();
  for (const b of intervals) if (b.start < end && b.end > start && b.customer !== self) who.add(b.customer);
  return who.size;
}

// ── Hourly follow-ups ───────────────────────────────────────────────────────

const langOf = (meta: SectorMeta): ReplyLanguage => resolveVoiceSettings(meta).language as ReplyLanguage;

export interface ClinicJobResult { businessType: string; orderId: string; job: 'recall' | 'no_show' | 'review'; outcome: SendOutcome }

/** Adds months to a local 'YYYY-MM-DD…' date (day clamped to the month's end). */
export function addMonths(localDate: string, months: number): string {
  const [y, m, d] = localDate.slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = total % 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

async function claim(env: Env, column: 'no_show_sent_at' | 'review_sent_at' | 'recall_sent_at', id: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE orders SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).bind(nowSec(), id).run();
  return !!r.meta?.changes;
}

type Row = { id: string; product_name: string; category: string | null; scheduled_at: string; callback_phone: string | null; customer_id_hashed: string; customer_name: string | null; visit_marked_at: number };

export async function runClinicFollowUps(env: Env, now = new Date()): Promise<ClinicJobResult[]> {
  const out: ClinicJobResult[] = [];
  const { results: on } = await env.DB.prepare(
    'SELECT * FROM clinic_features WHERE recalls = 1 OR no_show_recovery = 1 OR review_requests = 1',
  ).all<Record<string, any>>().catch(() => ({ results: [] as Record<string, any>[] }));
  const nowS = Math.floor(now.getTime() / 1000);
  for (const f of on ?? []) {
    const businessType = f.business_type as string;
    const meta = await getSector(env, businessType);
    if (!meta) continue;
    const lang = langOf(meta);
    const tz = meta.timezone || 'Asia/Kolkata';
    const today = wallClock(now, tz).slice(0, 10);
    const send = async (job: ClinicJobResult['job'], o: Row, run: () => Promise<SendOutcome>, col: string) => {
      const outcome = o.customer_id_hashed.startsWith('synthetic-') ? 'skipped:synthetic' as const
        : !o.callback_phone ? 'skipped:no_phone' as const : await run();
      await env.DB.prepare(`UPDATE orders SET ${col} = ? WHERE id = ?`).bind(outcome, o.id).run();
      out.push({ businessType, orderId: o.id, job, outcome });
    };
    const rows = async (where: string, ...binds: unknown[]) => (await env.DB.prepare(
      `SELECT o.id, o.product_name, p.category, o.scheduled_at, o.callback_phone, o.customer_id_hashed, o.customer_name, o.visit_marked_at
       FROM orders o LEFT JOIN products p ON p.id = o.product_id
       WHERE o.business_type = ? AND o.status != 'CANCELLED' AND ${where} ORDER BY o.scheduled_at LIMIT ${CLINIC_BATCH}`,
    ).bind(businessType, ...binds).all<Row>()).results ?? [];

    // No-show recovery: rebook message + a callback task for staff.
    if (f.no_show_recovery) {
      for (const o of await rows(`o.visit_status = 'no_show' AND o.no_show_sent_at IS NULL AND o.visit_marked_at >= ?`, nowS - MAX_AGE_SECONDS)) {
        if (!(await claim(env, 'no_show_sent_at', o.id))) continue;
        await getDb(env.DB).insert(callMessages).values({
          id: crypto.randomUUID(), businessType, callSid: null, customerIdHashed: o.customer_id_hashed,
          callerName: o.customer_name, callbackPhone: o.callback_phone,
          message: `Missed appointment (${o.product_name}, ${formatWhen(o.scheduled_at, 'en', today)}): call to rebook.`,
        });
        await send('no_show', o, () => sendEventMessage(env, {
          event: 'no_show', businessType, phone: o.callback_phone!, lang,
          params: [meta.name, o.product_name, formatWhen(o.scheduled_at, lang, today)],
          smsText: `${meta.name}: we missed you at your ${o.product_name} on ${formatWhen(o.scheduled_at, 'en', today)}. Reply or call${meta.phone ? ` ${meta.phone}` : ' us'} to book a new time. Reply STOP to opt out.`,
        }), 'no_show_channel');
      }
    }

    // Review requests: every completed visit, no rating gate (Google policy).
    if (f.review_requests && f.review_url) {
      // Only recent visits (scheduled in the last week): an old visit marked late gets no review request.
      const weekAgo = wallClock(new Date(now.getTime() - MAX_AGE_SECONDS * 1000), tz);
      for (const o of await rows(`o.visit_status = 'completed' AND o.review_sent_at IS NULL AND o.visit_marked_at <= ? AND o.visit_marked_at >= ?
          AND substr(o.scheduled_at, 1, 16) >= ?`, nowS - REVIEW_DELAY_SECONDS, nowS - MAX_AGE_SECONDS, weekAgo)) {
        if (!(await claim(env, 'review_sent_at', o.id))) continue;
        await send('review', o, () => sendEventMessage(env, {
          event: 'review_request', businessType, phone: o.callback_phone!, lang, params: [meta.name, f.review_url],
          smsText: `Thank you for visiting ${meta.name}. If you have a minute, please review us on Google: ${f.review_url} Reply STOP to opt out.`,
        }), 'review_channel');
      }
    }

    // Recalls: N months after a completed visit, if no later booking exists.
    if (f.recalls) {
      const months = Number(f.recall_months) || 6;
      // Visits whose recall date is today or up to a week ago (catch-up), in local dates.
      const latest = addMonths(today, -months), earliest = addMonths(wallClock(new Date(now.getTime() - 7 * 86_400_000), tz).slice(0, 10), -months);
      const cat = f.recall_category as string | null;
      for (const o of await rows(`o.visit_status = 'completed' AND o.recall_sent_at IS NULL
          AND substr(o.scheduled_at, 1, 10) <= ? AND substr(o.scheduled_at, 1, 10) >= ?${cat ? ' AND lower(p.category) = lower(?)' : ''}
          AND NOT EXISTS (SELECT 1 FROM orders l WHERE l.business_type = o.business_type AND l.customer_id_hashed = o.customer_id_hashed
            AND l.status != 'CANCELLED' AND l.scheduled_at > o.scheduled_at)`, latest, earliest, ...(cat ? [cat] : []))) {
        if (!(await claim(env, 'recall_sent_at', o.id))) continue;
        await send('recall', o, () => sendEventMessage(env, {
          event: 'recall', businessType, phone: o.callback_phone!, lang, params: [meta.name, monthsText(months, lang), o.product_name],
          smsText: `${meta.name}: it has been about ${monthsText(months, 'en')} since your last ${o.product_name}. Reply or call${meta.phone ? ` ${meta.phone}` : ' us'} to book your next visit. Reply STOP to opt out.`,
        }), 'recall_channel');
      }
    }
  }
  return out;
}
