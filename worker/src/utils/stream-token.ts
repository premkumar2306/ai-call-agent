import { SignJWT, jwtVerify } from 'jose';
import type { Env } from '../types';
import { tokenSecretKey } from '../config';

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
}

export async function signStreamToken(env: Env, businessType: string, callerHash?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ purpose: PURPOSE, businessType, ...(callerHash ? { callerHash } : {}) })
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
    };
  } catch {
    return null;
  }
}
