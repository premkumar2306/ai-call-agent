import { SignJWT, jwtVerify } from 'jose';
import type { Env } from '../types';
import { timingSafeEqual, tokenSecretKey } from '../config';

// Short-lived token that binds a Twilio Media Stream to the /twilio/inbound
// webhook that created it. /twilio/inbound is signature-verified, but the
// WebSocket that follows is not, so without this anyone could open
// /twilio/stream directly and spend Deepgram/Anthropic/Cartesia credits.
// Twilio delivers it back to us in the 'start' event's customParameters.

const PURPOSE = 'twilio-stream';
const TTL_SECONDS = 300; // only has to survive Twilio's connect, not the call

export interface StreamClaims {
  businessType: string;
  // HMAC of the caller's number (or of the CallSid when caller ID is
  // withheld) — the caller's identity for bookings and history. Carried in
  // the token because the media stream itself never sees the From number.
  callerHash?: string;
  // The caller's own number (E.164), so a booking or message carries a
  // callback number the shop can use. Absent when caller ID is withheld.
  callerPhone?: string;
}

export async function signStreamToken(env: Env, businessType: string, callerHash?: string, callerPhone?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ purpose: PURPOSE, businessType, ...(callerHash ? { callerHash } : {}), ...(callerPhone ? { callerPhone } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(tokenSecretKey(env));
}

/** Returns the claims the token was issued with, or null if invalid. */
export async function verifyStreamToken(env: Env, token: string): Promise<StreamClaims | null> {
  try {
    const { payload } = await jwtVerify(token, tokenSecretKey(env), { algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE || typeof payload.businessType !== 'string') return null;
    return {
      businessType: payload.businessType,
      callerHash: typeof payload.callerHash === 'string' ? payload.callerHash : undefined,
      callerPhone: typeof payload.callerPhone === 'string' ? payload.callerPhone : undefined,
    };
  } catch {
    return null;
  }
}

// ── Compact stream token (Exotel) ────────────────────────────────────────────
// Exotel caps a stream URL's query string at 256 characters, too short for
// the JWT above, so the Voicebot applet's URL carries this instead:
//   base64url(JSON {c: callSid, b: businessType, f?: from, e: exp}) "." base64url(HMAC-SHA256)
// It is bound to the call: CallRelay checks `c` against the start event's
// call_sid, so a token leaked from one call can't open a stream for another.

const COMPACT_PURPOSE = 'exotel-stream.';
const COMPACT_MAX_LEN = 240;   // leaves room for "t=" and Exotel's own params

export interface CompactStreamClaims {
  callSid: string;
  businessType: string;
  from?: string;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function compactSig(env: Env, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', tokenSecretKey(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(COMPACT_PURPOSE + body))));
}

export async function signCompactStreamToken(env: Env, claims: CompactStreamClaims, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const make = async (withFrom: boolean) => {
    const payload = { c: claims.callSid, b: claims.businessType, ...(withFrom && claims.from ? { f: claims.from } : {}), e: nowSec + TTL_SECONDS };
    const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    return `${body}.${await compactSig(env, body)}`;
  };
  // The caller's number is optional (CallRelay falls back to the start
  // event's `from`), so drop it rather than exceed Exotel's limit.
  const token = await make(true);
  return token.length <= COMPACT_MAX_LEN ? token : make(false);
}

export async function verifyCompactStreamToken(env: Env, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<CompactStreamClaims | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const expected = await compactSig(env, body);
    if (!timingSafeEqual(sig, expected)) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (typeof p.c !== 'string' || typeof p.b !== 'string' || typeof p.e !== 'number' || p.e < nowSec) return null;
    return { callSid: p.c, businessType: p.b, from: typeof p.f === 'string' ? p.f : undefined };
  } catch {
    return null;
  }
}
