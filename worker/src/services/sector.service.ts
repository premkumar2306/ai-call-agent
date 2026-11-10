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
    about:      row.about ?? undefined,
    notifyEmail: row.notifyEmail ?? undefined,
    capacity:   row.capacity ?? 1,
    aiDisclosure:     row.aiDisclosure ?? undefined,
    disclosureText:   row.disclosureText ?? undefined,
    privacyNoticeUrl: row.privacyNoticeUrl ?? undefined,
    retentionDays:    row.retentionDays ?? undefined,
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
  about?: string;
  notifyEmail?: string;
  capacity?: number;
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
    about:      data.about,
    notifyEmail: data.notifyEmail,
    capacity:   data.capacity ?? 1,
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
      about:      data.about,
      // Only overwritten when given, so re-saving a sector from an older
      // admin form doesn't wipe them.
      ...(data.notifyEmail !== undefined ? { notifyEmail: data.notifyEmail } : {}),
      ...(data.capacity !== undefined ? { capacity: data.capacity } : {}),
      isActive:   true,
      updatedAt:  now,
    },
  });
  // Invalidate cache
  await env.CACHE.delete(CACHE_KEY);
}

export interface PrivacySettings {
  aiDisclosure: boolean | null;     // null = automatic (on in India)
  disclosureText: string | null;    // null = built-in wording
  privacyNoticeUrl: string | null;
  retentionDays: number | null;     // null = keep
}

// Partial update of the DPDP settings (POST /admin/privacy/:key/settings).
// Only the keys present are written; null clears a setting.
export async function updatePrivacySettings(env: Env, key: string, settings: Partial<PrivacySettings>): Promise<boolean> {
  const set: Partial<typeof sectorsTable.$inferInsert> = {};
  if ('aiDisclosure' in settings) set.aiDisclosure = settings.aiDisclosure;
  if ('disclosureText' in settings) set.disclosureText = settings.disclosureText;
  if ('privacyNoticeUrl' in settings) set.privacyNoticeUrl = settings.privacyNoticeUrl;
  if ('retentionDays' in settings) set.retentionDays = settings.retentionDays;
  if (!Object.keys(set).length) return true;
  const rows = await getDb(env.DB).update(sectorsTable).set({ ...set, updatedAt: new Date() })
    .where(eq(sectorsTable.key, key)).returning({ key: sectorsTable.key });
  await env.CACHE.delete(CACHE_KEY);
  return rows.length > 0;
}
