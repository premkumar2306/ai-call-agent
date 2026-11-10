import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { phoneNumbers } from '../db/schema';
import type { Env } from '../types';
import type { TelephonyProvider } from '../telephony/types';

// Called number → business routing (table phone_numbers, migration 0013).

/**
 * Normalises a phone number to E.164, or null if it can't be one.
 *
 * `defaultCountry` (digits, e.g. '91') applies to national-format numbers:
 * Exotel reports Indian numbers as "08047123456" or "9876543210", Twilio
 * always sends E.164 already.
 */
export function normalizeE164(raw: string | undefined | null, defaultCountry = '91'): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (s.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);                       // 00 international prefix
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = defaultCountry + digits.slice(1);       // national trunk prefix
  } else if (digits.length === 10) {
    digits = defaultCountry + digits;                // bare national number
  }
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null;
}

// Each carrier's numbers are national-format in that carrier's home country.
export const PROVIDER_COUNTRY: Record<TelephonyProvider, string> = { twilio: '1', exotel: '91', plivo: '91' };

export interface PhoneNumberRow {
  number: string;
  provider: TelephonyProvider;
  businessType: string;
  label: string | null;
}

/**
 * The business a called number is mapped to, or null (no row, bad number, or
 * D1 unavailable — a lookup failure must fall back, never drop the call).
 */
export async function businessForNumber(env: Env, provider: TelephonyProvider, called: string | undefined | null): Promise<string | null> {
  const number = normalizeE164(called, PROVIDER_COUNTRY[provider]);
  if (!number) return null;
  try {
    const rows = await getDb(env.DB)
      .select({ businessType: phoneNumbers.businessType })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.number, number), eq(phoneNumbers.provider, provider)))
      .limit(1);
    return rows[0]?.businessType ?? null;
  } catch (e: any) {
    console.error('[phone-numbers] lookup failed', e?.message || e);
    return null;
  }
}

export async function listPhoneNumbers(env: Env): Promise<PhoneNumberRow[]> {
  const rows = await getDb(env.DB).select().from(phoneNumbers).orderBy(asc(phoneNumbers.provider), asc(phoneNumbers.number));
  return rows.map(r => ({ number: r.number, provider: r.provider as TelephonyProvider, businessType: r.businessType, label: r.label }));
}

export async function upsertPhoneNumber(env: Env, row: PhoneNumberRow): Promise<void> {
  const now = new Date();
  await getDb(env.DB).insert(phoneNumbers)
    .values({ ...row, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [phoneNumbers.number, phoneNumbers.provider],
      set: { businessType: row.businessType, label: row.label, updatedAt: now },
    });
}

export async function deletePhoneNumber(env: Env, provider: TelephonyProvider, number: string): Promise<boolean> {
  const res = await getDb(env.DB).delete(phoneNumbers)
    .where(and(eq(phoneNumbers.number, number), eq(phoneNumbers.provider, provider)))
    .returning({ number: phoneNumbers.number });
  return res.length > 0;
}
