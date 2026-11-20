// Pilot metrics (launch item 3): computed only from real rows, never sampled
// or estimated. Formulas are documented in docs/pilot-metrics.md; keep the two
// in step. A metric with no data is null ("no calls yet"), never 0%.

import { and, eq, gte, lt } from 'drizzle-orm';
import { getDb } from '../db/client';
import { callOutcomes, callRouting, metricsSettings, orders } from '../db/schema';
import type { Env, SectorMeta } from '../types';
import { getSector } from './sector.service';
import { parseHoursRanges } from './tool-router.service';
import { sendEmail } from './notify.service';

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;
/** A booking counts for a call if the same caller booked between call start and this long after it ended. */
export const BOOKING_ATTRIBUTION_SECONDS = 10 * 60;

export type MetricsSettings = typeof metricsSettings.$inferSelect;

// ── Writing outcomes ────────────────────────────────────────────────────────

export async function recordCallOutcome(env: Env, o: {
  carrier: string; callSid: string; businessType: string; callerHash?: string | null;
  startedAt: number; endedAt: number; userTurns: number; transferred: boolean; messageTaken: boolean; isTest: boolean;
  endReason?: string | null;
}): Promise<void> {
  try {
    await getDb(env.DB).insert(callOutcomes).values({
      ...o, callerHash: o.callerHash ?? null, endReason: o.endReason ?? null, durationSeconds: Math.max(0, o.endedAt - o.startedAt), createdAt: nowSec(),
    }).onConflictDoNothing();
  } catch (e: any) {
    console.error('[metrics] recordCallOutcome failed', o.businessType, e?.message || e);
  }
}

// ── After-hours ─────────────────────────────────────────────────────────────

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** True when `at` falls outside every opening range of that weekday (business time zone). Unknown hours → false. */
export function isAfterHours(hours: SectorMeta['hours'] | undefined, timeZone: string, at: Date): boolean {
  if (!hours || !Object.keys(hours).length) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const wd = parts.find(p => p.type === 'weekday')!.value.slice(0, 3).toLowerCase();
  const mins = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  const day = DAYS.find(d => d === wd);
  const raw = day ? (hours as Record<string, string | undefined>)[day] : undefined;
  if (!raw || /closed/i.test(raw)) return true;
  const ranges = parseHoursRanges(raw);
  if (!ranges.length) return false; // unparseable: don't claim after-hours
  return !ranges.some(r => mins >= r.openH * 60 + r.openM && mins < r.closeH * 60 + r.closeM);
}

// ── Computing ───────────────────────────────────────────────────────────────

export interface PilotMetrics {
  from: number; to: number;
  calls: number;                 // real calls that reached the assistant
  answered: number;              // caller spoke at least once
  answerRate: number | null;     // answered / calls
  overflowCalls: number;         // tagged overflow (item 2)
  afterHoursCalls: number;
  transfers: number;
  transferRate: number | null;   // transfers / answered
  bookingsFromCalls: number;     // bookings attributed to any call
  recoveredBookings: number;     // bookings attributed to an overflow or after-hours call
  noShow: { status: 'not_tracked' } | { status: 'ok'; before: number | null; after: number | null };
}

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

export async function computeMetrics(env: Env, businessType: string, from: number, to: number): Promise<PilotMetrics> {
  const db = getDb(env.DB);
  const sector = await getSector(env, businessType);
  const tz = sector?.timezone || 'Asia/Kolkata';
  const calls = (await db.select().from(callOutcomes).where(and(
    eq(callOutcomes.businessType, businessType), gte(callOutcomes.startedAt, from), lt(callOutcomes.startedAt, to),
  ))).filter(c => !c.isTest);
  const routes = await db.select().from(callRouting).where(and(
    eq(callRouting.businessType, businessType), gte(callRouting.createdAt, from - 3600), lt(callRouting.createdAt, to + 3600),
  ));
  const overflow = new Set(routes.filter(r => r.isOverflow).map(r => `${r.carrier}:${r.callSid}`));

  // Bookings made by the same caller during the call or shortly after it.
  const bookings = (await db.select({ id: orders.id, customer: orders.customerIdHashed, createdAt: orders.createdAt, status: orders.status })
    .from(orders).where(and(eq(orders.businessType, businessType),
      gte(orders.createdAt, new Date(from * 1000)), lt(orders.createdAt, new Date((to + BOOKING_ATTRIBUTION_SECONDS) * 1000)))))
    .filter(b => b.status !== 'CANCELLED' && !b.customer.startsWith('synthetic-'));

  let answered = 0, transfers = 0, overflowCalls = 0, afterHoursCalls = 0;
  const fromCalls = new Set<string>(), recovered = new Set<string>();
  for (const c of calls) {
    const isAnswered = c.userTurns > 0;
    if (isAnswered) answered++;
    if (c.transferred) transfers++;
    const isOverflow = overflow.has(`${c.carrier}:${c.callSid}`);
    const afterHours = isAfterHours(sector?.hours, tz, new Date(c.startedAt * 1000));
    if (isOverflow) overflowCalls++;
    if (afterHours) afterHoursCalls++;
    if (!c.callerHash) continue;
    for (const b of bookings) {
      const t = Math.floor(b.createdAt.getTime() / 1000);
      if (b.customer === c.callerHash && t >= c.startedAt && t <= c.endedAt + BOOKING_ATTRIBUTION_SECONDS) {
        fromCalls.add(b.id);
        if (isOverflow || afterHours) recovered.add(b.id);
      }
    }
  }
  return {
    from, to, calls: calls.length, answered, answerRate: rate(answered, calls.length),
    overflowCalls, afterHoursCalls, transfers, transferRate: rate(transfers, answered),
    bookingsFromCalls: fromCalls.size, recoveredBookings: recovered.size,
    noShow: await noShowRates(env, businessType, tz, from, to),
  };
}

/**
 * No-show rate = no_show ÷ (completed + no_show) over appointments scheduled in
 * the window, from visits staff marked (launch item 4). "before" is the
 * same-length window just before `from`. Not tracked until a visit is marked.
 */
export async function noShowRates(env: Env, businessType: string, timeZone: string, from: number, to: number): Promise<PilotMetrics['noShow']> {
  const local = (t: number) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(t * 1000)).replace(' ', 'T');
  const count = async (a: number, b: number) => {
    const r = await env.DB.prepare(`SELECT
        sum(CASE WHEN visit_status = 'no_show' THEN 1 ELSE 0 END) AS ns,
        sum(CASE WHEN visit_status IN ('no_show', 'completed') THEN 1 ELSE 0 END) AS marked
      FROM orders WHERE business_type = ? AND status != 'CANCELLED' AND substr(scheduled_at, 1, 16) >= ? AND substr(scheduled_at, 1, 16) < ?
        AND customer_id_hashed NOT LIKE 'synthetic-%'`)
      .bind(businessType, local(a), local(b)).first<{ ns: number | null; marked: number | null }>().catch(() => null);
    return { ns: Number(r?.ns ?? 0), marked: Number(r?.marked ?? 0) };
  };
  const after = await count(from, to);
  const before = await count(from - (to - from), from);
  if (!after.marked && !before.marked) return { status: 'not_tracked' };
  return { status: 'ok', before: rate(before.ns, before.marked), after: rate(after.ns, after.marked) };
}

// ── Settings, share link ────────────────────────────────────────────────────

export async function getMetricsSettings(env: Env, businessType: string): Promise<MetricsSettings | null> {
  const [row] = await getDb(env.DB).select().from(metricsSettings).where(eq(metricsSettings.businessType, businessType));
  return row ?? null;
}

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');

export async function saveMetricsSettings(env: Env, businessType: string, p: { weeklySummary?: boolean; shareEnabled?: boolean }): Promise<MetricsSettings> {
  const now = nowSec();
  const cur = await getMetricsSettings(env, businessType);
  const shareEnabled = p.shareEnabled ?? cur?.shareEnabled ?? false;
  // A new token each time sharing is turned on, so turning it off revokes old links for good.
  const shareToken = shareEnabled ? (cur?.shareEnabled && cur.shareToken ? cur.shareToken : randomToken()) : null;
  const values = { weeklySummary: p.weeklySummary ?? cur?.weeklySummary ?? false, shareEnabled, shareToken, updatedAt: now };
  await getDb(env.DB).insert(metricsSettings).values({ businessType, ...values, createdAt: now })
    .onConflictDoUpdate({ target: metricsSettings.businessType, set: values });
  return (await getMetricsSettings(env, businessType))!;
}

export async function businessForShareToken(env: Env, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const [row] = await getDb(env.DB).select().from(metricsSettings)
    .where(and(eq(metricsSettings.shareToken, token), eq(metricsSettings.shareEnabled, true)));
  return row?.businessType ?? null;
}

// ── Weekly summary ──────────────────────────────────────────────────────────

/** Monday 00:00 (business time zone) of the week containing `at`, as unix seconds and its date. */
export function weekStart(at: Date, timeZone: string): { date: string; unix: number } {
  const local = new Date(at.toLocaleString('en-US', { timeZone }));
  const offsetMs = local.getTime() - at.getTime();
  const dow = (local.getDay() + 6) % 7; // Mon = 0
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - dow);
  const unix = Math.floor((local.getTime() - offsetMs) / 1000);
  const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  return { date, unix };
}

const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export function summaryText(name: string, m: PilotMetrics): string {
  if (m.calls === 0) return `${name}: no calls reached your assistant last week.`;
  return [
    `${name}: last week your assistant handled ${m.calls} call${m.calls === 1 ? '' : 's'}.`,
    `- Answered (caller spoke): ${m.answered} (${pct(m.answerRate)})`,
    `- Overflow calls (forwarded from your line): ${m.overflowCalls}; after-hours calls: ${m.afterHoursCalls}`,
    `- Bookings made from calls: ${m.bookingsFromCalls}; recovered (overflow or after-hours): ${m.recoveredBookings}`,
    `- Transferred to staff: ${m.transfers} (${pct(m.transferRate)} of answered calls)`,
  ].join('\n');
}

/**
 * Daily cron: on Mondays (business time zone) emails last week's summary to
 * businesses that turned it on. Once per week per business.
 */
export async function runWeeklySummaries(env: Env, now = new Date()): Promise<Array<{ businessType: string; sent: boolean }>> {
  const rows = await getDb(env.DB).select().from(metricsSettings).where(eq(metricsSettings.weeklySummary, true));
  const out: Array<{ businessType: string; sent: boolean }> = [];
  for (const s of rows) {
    const sector = await getSector(env, s.businessType);
    if (!sector) continue;
    const tz = sector.timezone || 'Asia/Kolkata';
    const thisWeek = weekStart(now, tz);
    const lastWeek = weekStart(new Date((thisWeek.unix - DAY) * 1000), tz);
    if (s.weeklyLastSent && s.weeklyLastSent >= lastWeek.date) continue;
    const to = sector.notifyEmail;
    if (!to) { out.push({ businessType: s.businessType, sent: false }); continue; }
    const m = await computeMetrics(env, s.businessType, lastWeek.unix, thisWeek.unix);
    await sendEmail(env, to, `${sector.name}: your assistant last week`, summaryText(sector.name, m) +
      '\n\nThese numbers come from your real calls and bookings. Turn this email off in Home → Pilot results.\n');
    await getDb(env.DB).update(metricsSettings).set({ weeklyLastSent: lastWeek.date, updatedAt: nowSec() })
      .where(eq(metricsSettings.businessType, s.businessType));
    out.push({ businessType: s.businessType, sent: true });
  }
  return out;
}
