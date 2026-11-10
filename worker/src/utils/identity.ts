import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { customers as customersTable } from '../db/schema';
import type { Env } from '../types';

export async function hashId(id: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getOrCreateCustomer(
  env: Env,
  idHashed: string,
): Promise<{ tier: 'BASIC' | 'SILVER' | 'GOLD' | 'PLATINUM'; store_credit_cents: number }> {
  const db = getDb(env.DB);
  const rows = await db.select().from(customersTable).where(eq(customersTable.idHashed, idHashed));

  if (rows[0]) {
    return {
      tier: rows[0].tier as 'BASIC' | 'SILVER' | 'GOLD' | 'PLATINUM',
      store_credit_cents: rows[0].storeCreditCents,
    };
  }

  const now = new Date();
  await db.insert(customersTable).values({
    idHashed,
    tier: 'BASIC',
    storeCreditCents: 0,
    createdAt: now,
    updatedAt: now,
  });
  return { tier: 'BASIC', store_credit_cents: 0 };
}

/**
 * A voice caller's identity from the number they called from, as
 * /twilio/inbound derives it: HMAC of the number's digits (the same key
 * WhatsApp hashes, so a customer is one identity across channels), or a
 * per-call identity when caller ID is withheld. `callerPhone` is the E.164
 * number, kept as the default callback number.
 *
 * `normalize` maps the carrier's format to E.164 (Exotel reports Indian
 * numbers in national format, "09876543210").
 */
export async function callerIdentity(
  rawFrom: string | undefined,
  callSid: string,
  salt: string,
  normalize: (raw: string) => string | null,
): Promise<{ callerHash: string; callerPhone?: string }> {
  const e164 = rawFrom ? normalize(rawFrom) : null;
  const key = e164 ? e164.slice(1) : `call:${callSid}`;
  return { callerHash: await hashId(key, salt), callerPhone: e164 ?? undefined };
}
