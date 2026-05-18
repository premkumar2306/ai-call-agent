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
