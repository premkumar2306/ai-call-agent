import type { Env } from '../types';
import type { TelephonyProvider } from './types';
import { logEvent } from '../utils/telemetry';
import { carrierEnded, recordCarrierTiming, recordHangupMethod, markCarrierEnded } from '../services/call-end';
import { canHangupViaRest, carrierHangup, carrierStatus } from './carrier-rest';

// CallTerminator: makes sure a call we ended really ends (docs/architecture/call-termination.md).
//
//   request()  our side ended the call (the caller closes the media stream as before)
//   +verifyMs  alarm: did the carrier end it? callback in KV → done; else ask the carrier;
//              still live → REST hangup (Twilio/Plivo); Exotel has no hangup API: alert only
//   +recheckMs alarm: confirm the REST hangup worked, else log call.hangup_unconfirmed
//
// State lives in Durable Object storage and the single DO alarm is multiplexed here
// (verify, recheck, and the max-duration backstop), so it all works after an eviction,
// with no live socket. Transfers are never hung up by REST: the staff leg is the call.

export interface TermState {
  callSid: string;
  provider: TelephonyProvider;
  /** Absolute time the max-duration backstop fires if the call is still ours. */
  backstopAt: number;
  verifyMs: number;
  requested?: { reason: string; at: number };
  verifyAt?: number;
  recheckAt?: number;
  hangupSent?: boolean;
  done?: boolean;
}

export const VERIFY_MS = 5000;
const KEY = 'term';
const RECHECK_MS = 3000;

type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'setAlarm' | 'deleteAlarm'>;

export class CallTerminator {
  private st?: TermState;
  constructor(private storage: Storage, private env: Env) {}

  async load(): Promise<TermState | undefined> {
    this.st ??= await this.storage.get<TermState>(KEY);
    return this.st;
  }

  private async save() {
    if (!this.st) return;
    await this.storage.put(KEY, this.st);
    const at = [!this.st.requested ? this.st.backstopAt : undefined, this.st.verifyAt, this.st.recheckAt]
      .filter((t): t is number => typeof t === 'number');
    if (this.st.done || !at.length) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.min(...at));
  }

  async start(callSid: string, provider: TelephonyProvider, backstopAt: number, verifyMs = VERIFY_MS) {
    this.st = { callSid, provider, backstopAt, verifyMs };
    await this.save();
  }

  get requested(): boolean { return !!this.st?.requested; }

  /** Our side ended the call. Idempotent: only the first request acts. Returns true on the first. */
  async request(reason: string): Promise<boolean> {
    const st = await this.load();
    if (!st || st.requested) return false;
    const now = Date.now();
    st.requested = { reason, at: now };
    st.verifyAt = now + st.verifyMs;
    await this.save();
    logEvent('warn', 'call.hangup_requested', { callId: st.callSid.slice(-8), provider: st.provider, reason });
    return true;
  }

  /** The alarm fired. Returns 'backstop' when the max-duration backstop is due and the call was never ended by us. */
  async onAlarm(now = Date.now()): Promise<'backstop' | 'handled' | 'none'> {
    const st = await this.load();
    if (!st || st.done) return 'none';
    if (!st.requested) return now >= st.backstopAt ? 'backstop' : (await this.save(), 'handled');
    if (st.recheckAt && now >= st.recheckAt) { st.recheckAt = undefined; await this.recheck(st); }
    else if (st.verifyAt && now >= st.verifyAt) { st.verifyAt = undefined; await this.verify(st); }
    await this.save();
    return 'handled';
  }

  private confirmed(st: TermState, by: string) {
    st.done = true;
    const ms = Date.now() - (st.requested?.at ?? Date.now());
    logEvent('info', 'call.hangup_confirmed', { callId: st.callSid.slice(-8), provider: st.provider, by, msToConfirm: ms, reason: st.requested?.reason ?? '' });
    return recordHangupMethod(this.env, st.callSid, by, ms);
  }

  private async verify(st: TermState) {
    const id = st.callSid.slice(-8);
    const cb = await carrierEnded(this.env, st.callSid);
    if (cb) {
      await recordCarrierTiming(this.env, st.callSid, cb);
      return this.confirmed(st, st.hangupSent ? 'rest' : 'callback');
    }
    const s = await carrierStatus(this.env, st.provider, st.callSid);
    logEvent('info', 'call.hangup_status', { callId: id, provider: st.provider, phase: s.phase, httpStatus: s.httpStatus ?? 0, carrierStatus: s.carrierStatus ?? '' });
    if (s.phase === 'ended') {
      await markCarrierEnded(this.env, st.callSid, { endedAt: s.endedAt, durationSec: s.durationSec, source: 'status_poll' });
      return this.confirmed(st, 'status_poll');
    }
    if (s.phase === 'unknown') {
      // Not readable (no credentials, or the carrier errored): nothing more we can do from here.
      st.done = true;
      logEvent('error', 'call.hangup_unconfirmed', { callId: id, provider: st.provider, why: s.httpStatus ? `status read http ${s.httpStatus}` : 'no credentials or network error' });
      return recordHangupMethod(this.env, st.callSid, 'unconfirmed', null);
    }
    // Live. A transfer is supposed to be (the staff leg); never cut it.
    if (st.requested?.reason === 'transfer') { st.done = true; return; }
    if (!canHangupViaRest(this.env, st.provider)) {
      st.done = true;
      logEvent('error', 'call.hangup_unconfirmed', { callId: id, provider: st.provider, why: 'still live; no REST hangup for this carrier (check the call flow)' });
      return recordHangupMethod(this.env, st.callSid, 'unconfirmed', null);
    }
    const r = await carrierHangup(this.env, st.provider, st.callSid);
    st.hangupSent = true;
    logEvent('warn', 'call.hangup_rest', { callId: id, provider: st.provider, ok: !!r?.ok, alreadyEnded: !!r?.alreadyEnded, httpStatus: r?.httpStatus ?? 0 });
    st.recheckAt = Date.now() + Math.min(RECHECK_MS, st.verifyMs);
  }

  private async recheck(st: TermState) {
    const s = await carrierStatus(this.env, st.provider, st.callSid);
    logEvent('info', 'call.hangup_status', { callId: st.callSid.slice(-8), provider: st.provider, phase: s.phase, httpStatus: s.httpStatus ?? 0, carrierStatus: s.carrierStatus ?? '', after: 'rest' });
    if (s.phase === 'ended') {
      await markCarrierEnded(this.env, st.callSid, { endedAt: s.endedAt, durationSec: s.durationSec, source: 'rest' });
      return this.confirmed(st, 'rest');
    }
    st.done = true;
    logEvent('error', 'call.hangup_unconfirmed', { callId: st.callSid.slice(-8), provider: st.provider, why: `still ${s.phase} after REST hangup` });
    return recordHangupMethod(this.env, st.callSid, 'unconfirmed', null);
  }
}
