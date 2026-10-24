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

export async function signStreamToken(env: Env, businessType: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ purpose: PURPOSE, businessType })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(tokenSecretKey(env));
}

/** Returns the businessType the token was issued for, or null if invalid. */
export async function verifyStreamToken(env: Env, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, tokenSecretKey(env), { algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE || typeof payload.businessType !== 'string') return null;
    return payload.businessType;
  } catch {
    return null;
  }
}
