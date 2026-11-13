import { HTTP_TIMEOUT_MS } from '../config';
import type { Env } from '../types';

export const smsConfigured = (env: Env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);

/** One text through Twilio. A no-op (logged) when SMS isn't configured; throws on an HTTP error. */
export async function sendSms(env: Env, to: string, body: string): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID;
  if (!sid || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_SMS_FROM) {
    console.log('[notify] Twilio SMS not configured; skipping text');
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_SMS_FROM, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio SMS ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
