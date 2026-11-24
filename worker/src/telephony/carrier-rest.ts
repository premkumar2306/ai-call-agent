import type { Env } from '../types';
import type { TelephonyProvider } from './types';
import { parseEpoch } from '../services/call-end';

// The carriers' REST APIs, used only to end a call that did not end when we closed
// its media stream (see docs/architecture/call-termination.md). Credentials come from
// the Worker's existing secrets and are never logged.

export type CarrierPhase = 'live' | 'ended' | 'unknown';
export interface CarrierStatus { phase: CarrierPhase; httpStatus?: number; carrierStatus?: string; endedAt?: number; durationSec?: number }
export interface HangupResult { ok: boolean; alreadyEnded: boolean; httpStatus: number }

const TIMEOUT_MS = 5000;
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

interface Req { url: string; auth: string }

function creds(env: Env, provider: TelephonyProvider, sid: string, op: 'status' | 'hangup'): Req | null {
  const e = encodeURIComponent(sid);
  if (provider === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
    return { url: `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${e}.json`, auth: basic(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) };
  }
  if (provider === 'plivo') {
    if (!env.PLIVO_AUTH_ID || !env.PLIVO_AUTH_TOKEN) return null;
    return { url: `https://api.plivo.com/v1/Account/${env.PLIVO_AUTH_ID}/Call/${e}/${op === 'status' ? '?status=live' : ''}`, auth: basic(env.PLIVO_AUTH_ID, env.PLIVO_AUTH_TOKEN) };
  }
  // Exotel: status read only (no live-call hangup API is known; UNVERIFIED).
  if (op === 'hangup' || !env.EXOTEL_ACCOUNT_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN) return null;
  return { url: `https://${env.EXOTEL_SUBDOMAIN || 'api.exotel.com'}/v1/Accounts/${env.EXOTEL_ACCOUNT_SID}/Calls/${e}.json`, auth: basic(env.EXOTEL_API_KEY, env.EXOTEL_API_TOKEN) };
}

/** True when this carrier can be asked to end a live call. */
export const canHangupViaRest = (env: Env, provider: TelephonyProvider) => !!creds(env, provider, 'x', 'hangup');
export const canReadStatus = (env: Env, provider: TelephonyProvider) => !!creds(env, provider, 'x', 'status');

const LIVE = new Set(['queued', 'ringing', 'in-progress', 'in_progress', 'live']);

export async function carrierStatus(env: Env, provider: TelephonyProvider, sid: string): Promise<CarrierStatus> {
  const r = creds(env, provider, sid, 'status');
  if (!r) return { phase: 'unknown' };
  try {
    const res = await fetch(r.url, { headers: { Authorization: r.auth, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (provider === 'plivo') {
      // ?status=live: 404 once the call is no longer live.
      if (res.status === 404) return { phase: 'ended', httpStatus: 404 };
      if (!res.ok) return { phase: 'unknown', httpStatus: res.status };
      return { phase: 'live', httpStatus: res.status, carrierStatus: 'live' };
    }
    if (!res.ok) return { phase: 'unknown', httpStatus: res.status };
    const j: any = await res.json().catch(() => ({}));
    if (provider === 'twilio') {
      const st = String(j.status ?? '');
      return { phase: LIVE.has(st) ? 'live' : st ? 'ended' : 'unknown', httpStatus: 200, carrierStatus: st, endedAt: parseEpoch(j.end_time), durationSec: j.duration != null ? Number(j.duration) : undefined };
    }
    const c = j.Call ?? j.call ?? {};
    const st = String(c.Status ?? '').toLowerCase();
    return { phase: LIVE.has(st) ? 'live' : st ? 'ended' : 'unknown', httpStatus: 200, carrierStatus: st, durationSec: c.Duration != null ? Number(c.Duration) : undefined };
  } catch {
    return { phase: 'unknown' };
  }
}

/** Ends the call. One retry on a 5xx or network error. An already-ended call counts as ended. */
export async function carrierHangup(env: Env, provider: TelephonyProvider, sid: string): Promise<HangupResult | null> {
  const r = creds(env, provider, sid, 'hangup');
  if (!r) return null;
  let last: HangupResult = { ok: false, alreadyEnded: false, httpStatus: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const init: RequestInit = provider === 'twilio'
        ? { method: 'POST', headers: { Authorization: r.auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Status=completed' }
        : { method: 'DELETE', headers: { Authorization: r.auth } };
      const res = await fetch(r.url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      let alreadyEnded = res.status === 404;
      if (provider === 'twilio' && res.status === 400) {
        const j: any = await res.json().catch(() => ({}));
        alreadyEnded = j?.code === 21220;   // "call is not in-progress"
      }
      last = { ok: res.ok, alreadyEnded, httpStatus: res.status };
      if (res.ok || alreadyEnded || res.status < 500) return last;
    } catch {
      last = { ok: false, alreadyEnded: false, httpStatus: 0 };
    }
    if (attempt === 0) await new Promise(r2 => setTimeout(r2, 1000));
  }
  return last;
}
