// Overflow-only pilots on the clinic's existing number (launch item 2).
//
// The clinic keeps its number and staff answer first. On busy, no answer or
// unreachable the clinic's carrier forwards the call to the Avery number
// (conditional call forwarding). Every call that reaches Avery during an
// active pilot is tagged as overflow: in an overflow-only pilot the Avery
// number is not published, so a call can only arrive by forwarding. When the
// carrier also says the call was forwarded (Plivo/Twilio ForwardedFrom), the
// forwarding number is captured.
//
// Off by default: a business without an enabled pilot_configs row behaves
// exactly as before, and its calls are only recorded here when the carrier
// itself marks them as forwarded.

import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../db/client';
import { callRouting, pilotConfigs } from '../db/schema';
import type { Env } from '../types';
import { getSector } from './sector.service';
import { normalizeE164 } from './phone-numbers';

export type PilotConfig = typeof pilotConfigs.$inferSelect;
export type CallRoute = typeof callRouting.$inferSelect;
export type Carrier = 'twilio' | 'exotel' | 'plivo';

const nowSec = () => Math.floor(Date.now() / 1000);
export const FORWARDING_TEST_WINDOW_SECONDS = 15 * 60;
export const CLINIC_LINES = ['jio', 'airtel', 'vi', 'bsnl', 'landline', 'ivr', 'other'] as const;

/** 'YYYY-MM-DD' of `at` in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** True while an enabled overflow pilot covers today (dates inclusive, business time zone). */
export function pilotActive(cfg: Pick<PilotConfig, 'enabled' | 'mode' | 'startsOn' | 'endsOn'> | null | undefined,
  at: Date, timeZone = 'Asia/Kolkata'): boolean {
  if (!cfg?.enabled || cfg.mode !== 'overflow') return false;
  const today = localDate(at, timeZone);
  if (cfg.startsOn && today < cfg.startsOn) return false;
  if (cfg.endsOn && today > cfg.endsOn) return false;
  return true;
}

export interface Classified { isOverflow: boolean; reason: 'carrier_forwarded' | 'pilot_overflow' | 'direct'; pilotActive: boolean }

export function classifyCall(forwardedFrom: string | null, active: boolean): Classified {
  if (forwardedFrom) return { isOverflow: true, reason: 'carrier_forwarded', pilotActive: active };
  if (active) return { isOverflow: true, reason: 'pilot_overflow', pilotActive: true };
  return { isOverflow: false, reason: 'direct', pilotActive: false };
}

/**
 * The forwarding number from a carrier webhook, when it sends one.
 * Plivo and Twilio: `ForwardedFrom`. Exotel lists `ForwardedFrom` as
 * deprecated (not to be relied on), so it is read only if present.
 */
export function forwardedFromParam(params: Record<string, unknown>, defaultCountry = '91'): string | null {
  for (const k of ['ForwardedFrom', 'forwarded_from', 'Forwarded_From']) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) return normalizeE164(v, defaultCountry) ?? v.trim().slice(0, 32);
  }
  return null;
}

export async function getPilotConfig(env: Env, businessType: string): Promise<PilotConfig | null> {
  const [row] = await getDb(env.DB).select().from(pilotConfigs).where(eq(pilotConfigs.businessType, businessType));
  return row ?? null;
}

/**
 * Records how a call reached Avery. Called from each carrier's answer
 * webhook via waitUntil, so it never delays or breaks the call. Writes only
 * for businesses with a pilot config, or when the carrier marked the call as
 * forwarded.
 */
export async function recordCallRouting(env: Env, r: {
  carrier: Carrier; callSid: string | undefined | null; businessType: string;
  calledNumber?: string | null; callerHash?: string | null; forwardedFrom?: string | null;
}): Promise<void> {
  try {
    if (!r.callSid) return;
    const cfg = await getPilotConfig(env, r.businessType);
    if (!cfg && !r.forwardedFrom) return;
    const tz = (await getSector(env, r.businessType))?.timezone || 'Asia/Kolkata';
    const c = classifyCall(r.forwardedFrom ?? null, pilotActive(cfg, new Date(), tz));
    await getDb(env.DB).insert(callRouting).values({
      carrier: r.carrier, callSid: r.callSid, businessType: r.businessType,
      calledNumber: r.calledNumber ?? null, callerHash: r.callerHash ?? null, forwardedFrom: r.forwardedFrom ?? null,
      isOverflow: c.isOverflow, reason: c.reason, pilotActive: c.pilotActive, createdAt: nowSec(),
    }).onConflictDoNothing();
  } catch (e: any) {
    console.error('[pilot] recordCallRouting failed', r.businessType, e?.message || e);
  }
}

export interface PilotInput {
  enabled: boolean; startsOn: string | null; endsOn: string | null; clinicNumber: string | null; clinicLine: string | null;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function validatePilotInput(b: any): PilotInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const date = (v: unknown) => v === null || v === undefined || v === '' ? null : typeof v === 'string' && DATE_RE.test(v) ? v : undefined;
  const startsOn = date(b.startsOn), endsOn = date(b.endsOn);
  if (startsOn === undefined || endsOn === undefined) return 'Dates must be YYYY-MM-DD';
  if (startsOn && endsOn && endsOn < startsOn) return 'The end date is before the start date';
  if (b.enabled === true && (!startsOn || !endsOn)) return 'A pilot needs a start and an end date';
  let clinicNumber: string | null = null;
  if (typeof b.clinicNumber === 'string' && b.clinicNumber.trim()) {
    clinicNumber = normalizeE164(b.clinicNumber, '91');
    if (!clinicNumber) return 'Clinic number must be a phone number, e.g. +91 80 4710 0000';
  }
  const clinicLine = typeof b.clinicLine === 'string' && (CLINIC_LINES as readonly string[]).includes(b.clinicLine) ? b.clinicLine : null;
  return { enabled: b.enabled === true, startsOn, endsOn, clinicNumber, clinicLine };
}

export async function savePilotConfig(env: Env, businessType: string, p: PilotInput): Promise<PilotConfig> {
  const now = nowSec();
  const values = { ...p, mode: 'overflow', updatedAt: now };
  await getDb(env.DB).insert(pilotConfigs).values({ businessType, ...values, createdAt: now })
    .onConflictDoUpdate({ target: pilotConfigs.businessType, set: values });
  return (await getPilotConfig(env, businessType))!;
}

/** Opens the "test your forwarding" window (creates a disabled config if there is none). */
export async function startForwardingTest(env: Env, businessType: string): Promise<number> {
  const now = nowSec();
  const existing = await getPilotConfig(env, businessType);
  if (existing) {
    await getDb(env.DB).update(pilotConfigs).set({ forwardingTestStartedAt: now, updatedAt: now })
      .where(eq(pilotConfigs.businessType, businessType));
  } else {
    await getDb(env.DB).insert(pilotConfigs).values({ businessType, enabled: false, forwardingTestStartedAt: now, createdAt: now, updatedAt: now });
  }
  return now;
}

export type ForwardingTestStatus = 'not_started' | 'waiting' | 'received' | 'expired';

/**
 * Result of the forwarding test: the first call that reached Avery after the
 * test started. "received" proves the forward works; `forwardedFromMatches`
 * says whether the carrier also identified the clinic's number.
 */
export async function forwardingTestResult(env: Env, businessType: string, now = nowSec()) {
  const cfg = await getPilotConfig(env, businessType);
  const startedAt = cfg?.forwardingTestStartedAt ?? null;
  if (!startedAt) return { status: 'not_started' as ForwardingTestStatus, startedAt: null, call: null };
  const [call] = await getDb(env.DB).select().from(callRouting)
    .where(and(eq(callRouting.businessType, businessType), gte(callRouting.createdAt, startedAt)))
    .orderBy(callRouting.createdAt).limit(1);
  const status: ForwardingTestStatus = call ? 'received' : now - startedAt > FORWARDING_TEST_WINDOW_SECONDS ? 'expired' : 'waiting';
  return {
    status, startedAt, expiresAt: startedAt + FORWARDING_TEST_WINDOW_SECONDS,
    call: call && {
      at: call.createdAt, carrier: call.carrier, calledNumber: call.calledNumber, forwardedFrom: call.forwardedFrom,
      reason: call.reason,
      forwardedFromMatches: call.forwardedFrom && cfg?.clinicNumber ? call.forwardedFrom === cfg.clinicNumber : null,
    },
  };
}

export async function recentRoutes(env: Env, businessType: string, limit = 50): Promise<CallRoute[]> {
  return getDb(env.DB).select().from(callRouting).where(eq(callRouting.businessType, businessType))
    .orderBy(desc(callRouting.createdAt)).limit(limit);
}

/** Runs work after the response when the runtime allows it (tests have no ExecutionContext). */
export function background(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, p: Promise<unknown>): void {
  try { c.executionCtx.waitUntil(p); } catch { p.catch(() => {}); }
}
