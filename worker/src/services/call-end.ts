import type { Env } from '../types';

// What the carrier says about the end of a call. Written by the carrier's status
// callbacks (Twilio /status, Plivo /hangup) and by CallTerminator's status read; it is
// read back by CallTerminator, and stored next to our own timing on call_outcomes.
// Log-only: billing still uses our own duration.
export interface CarrierEnd { endedAt?: number; durationSec?: number; source: string }

const key = (sid: string) => `ended:${sid}`;

export async function markCarrierEnded(env: Env, sid: string, end: CarrierEnd): Promise<void> {
  if (!sid) return;
  await env.CACHE.put(key(sid), JSON.stringify(end), { expirationTtl: 3600 }).catch(() => {});
  await recordCarrierTiming(env, sid, end);
}

export async function carrierEnded(env: Env, sid: string): Promise<CarrierEnd | null> {
  try {
    const raw = await env.CACHE.get(key(sid));
    return raw ? JSON.parse(raw) as CarrierEnd : null;
  } catch { return null; }
}

/** UPDATE only: the row is created when the call is finalised; the caller of this retries once the row exists. */
export async function recordCarrierTiming(env: Env, sid: string, end: CarrierEnd): Promise<void> {
  if (end.endedAt == null && end.durationSec == null) return;
  await env.DB.prepare('UPDATE call_outcomes SET carrier_ended_at = COALESCE(?, carrier_ended_at), carrier_duration_seconds = COALESCE(?, carrier_duration_seconds) WHERE call_sid = ?')
    .bind(end.endedAt ?? null, end.durationSec != null ? Math.round(end.durationSec) : null, sid).run().catch(() => {});
}

export async function recordHangupMethod(env: Env, sid: string, method: string, confirmMs: number | null): Promise<void> {
  await env.DB.prepare('UPDATE call_outcomes SET hangup_method = ?, hangup_confirm_ms = ? WHERE call_sid = ?')
    .bind(method, confirmMs, sid).run().catch(() => {});
}

/** Epoch seconds from an RFC 2822 / ISO date string, or undefined. */
export function parseEpoch(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}
