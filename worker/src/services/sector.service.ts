import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sectors as sectorsTable } from '../db/schema';
import type { Env, SectorMeta } from '../types';

const CACHE_KEY = 'sectors_list';
const CACHE_TTL = 300; // 5 minutes

function rowToMeta(row: typeof sectorsTable.$inferSelect): SectorMeta {
  return {
    name:       row.name,
    model:      row.model as SectorMeta['model'],
    categories: row.categories as string[],
    hours:      row.hours as SectorMeta['hours'],
    timezone:   row.timezone,
    currency:   row.currency,
    address:    row.address ?? undefined,
    phone:      row.phone ?? undefined,
    website:    row.website ?? undefined,
  };
}

export async function getSectors(env: Env): Promise<Record<string, SectorMeta>> {
  const cached = await env.CACHE.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const db = getDb(env.DB);
  const rows = await db.select().from(sectorsTable).where(eq(sectorsTable.isActive, true));
  const result: Record<string, SectorMeta> = {};
  for (const row of rows) result[row.key] = rowToMeta(row);

  await env.CACHE.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  return result;
}

export async function getSector(env: Env, key: string): Promise<SectorMeta | null> {
  const all = await getSectors(env);
  return all[key] ?? null;
}

export async function upsertSector(env: Env, key: string, data: {
  name: string;
  model: string;
  categories: string[];
  hours: Record<string, string>;
  timezone?: string;
  currency?: string;
  address?: string;
  phone?: string;
  website?: string;
}): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();
  await db.insert(sectorsTable).values({
    key,
    name:       data.name,
    model:      data.model,
    categories: data.categories,
    hours:      data.hours,
    timezone:   data.timezone ?? 'America/Chicago',
    currency:   data.currency ?? 'USD',
    address:    data.address,
    phone:      data.phone,
    website:    data.website,
    isActive:   true,
    createdAt:  now,
    updatedAt:  now,
  }).onConflictDoUpdate({
    target: sectorsTable.key,
    set: {
      name:       data.name,
      model:      data.model,
      categories: data.categories,
      hours:      data.hours,
      timezone:   data.timezone ?? 'America/Chicago',
      currency:   data.currency ?? 'USD',
      address:    data.address,
      phone:      data.phone,
      website:    data.website,
      isActive:   true,
      updatedAt:  now,
    },
  });
  // Invalidate cache
  await env.CACHE.delete(CACHE_KEY);
}
