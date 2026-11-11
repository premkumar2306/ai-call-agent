import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { numberRequests, resources, whatsappNumbers } from '../db/schema';
import { parseHoursRanges } from './tool-router.service';
import { invalidateSectors } from './sector.service';
import type { Env } from '../types';
import { HTTP_TIMEOUT_MS } from '../config';
import { escapeHtml } from './email.service';

// Owner self-service: a business's practitioners (doctors, dentists, lawyers —
// `resources`), WhatsApp number routing (operator) and phone-number requests.

// ── Practitioners (resources) ──────────────────────────────────────────────

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface ResourceInput {
  name: string;
  role: string | null;
  hours: Record<string, string>;
  slotMinutes: number;
  feeCents: number | null;
  about: string | null;
  categories: string[] | null;
  isActive: boolean;
}

/**
 * Validates an owner's practitioner form. `partial` (an edit) keeps fields
 * that aren't sent; `existing` supplies them.
 */
export function parseResourceInput(b: any, existing?: ResourceInput): ResourceInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const has = (k: string) => b[k] !== undefined;
  const out: ResourceInput = existing ? { ...existing } : {
    name: '', role: null, hours: {}, slotMinutes: 15, feeCents: null, about: null, categories: null, isActive: true,
  };
  if (has('name') || !existing) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2 || name.length > 120) return 'Name must be 2–120 characters';
    out.name = name;
  }
  if (has('role')) out.role = typeof b.role === 'string' && b.role.trim() ? b.role.trim().slice(0, 120) : null;
  if (has('hours') || !existing) {
    if (!b.hours || typeof b.hours !== 'object') return 'Hours are required';
    const hours: Record<string, string> = {};
    for (const d of DAYS) {
      const v = b.hours[d];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || v.length > 80 || !parseHoursRanges(v).length) return `Hours for ${d} are not valid (use e.g. 10am–1pm, 5pm–9pm)`;
      hours[d] = v.trim();
    }
    if (!Object.keys(hours).length) return 'Add hours for at least one day';
    out.hours = hours;
  }
  if (has('slotMinutes')) {
    if (!Number.isInteger(b.slotMinutes) || b.slotMinutes < 5 || b.slotMinutes > 240) return 'Appointment length must be 5–240 minutes';
    out.slotMinutes = b.slotMinutes;
  }
  if (has('feeCents')) {
    if (b.feeCents === null || b.feeCents === '') out.feeCents = null;
    else if (!Number.isInteger(b.feeCents) || b.feeCents < 0 || b.feeCents > 100_000_000) return 'Fee is not valid';
    else out.feeCents = b.feeCents;
  }
  if (has('about')) out.about = typeof b.about === 'string' && b.about.trim() ? b.about.trim().slice(0, 1000) : null;
  if (has('categories')) {
    if (b.categories === null) out.categories = null;
    else {
      if (!Array.isArray(b.categories) || b.categories.length > 20) return 'Categories must be a list';
      const cats = [...new Set<string>(b.categories.map((c: unknown) => typeof c === 'string' ? c.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : ''))]
        .filter(c => !!c && c.length <= 40);
      out.categories = cats.length ? cats : null;
    }
  }
  if (has('isActive')) {
    if (typeof b.isActive !== 'boolean') return 'isActive must be true or false';
    out.isActive = b.isActive;
  }
  return out;
}

export const MAX_RESOURCES = 50;

export async function listResources(env: Env, businessType: string) {
  return getDb(env.DB).select().from(resources)
    .where(eq(resources.businessType, businessType))
    .orderBy(asc(resources.sortOrder), asc(resources.name));
}

function randomId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export async function createResource(env: Env, businessType: string, r: ResourceInput) {
  const existing = await listResources(env, businessType);
  if (existing.length >= MAX_RESOURCES) return null;
  const [row] = await getDb(env.DB).insert(resources).values({
    id: `${businessType}-res-${randomId()}`, businessType, ...r,
    sortOrder: existing.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 1, createdAt: new Date(),
  }).returning();
  await invalidateSectors(env);
  return row;
}

/** Updates one of this business's resources; null if it isn't theirs. */
export async function updateResource(env: Env, businessType: string, id: string, r: Partial<ResourceInput>) {
  const [row] = await getDb(env.DB).update(resources).set(r)
    .where(and(eq(resources.id, id), eq(resources.businessType, businessType))).returning();
  await invalidateSectors(env);
  return row ?? null;
}

export function resourceRowToInput(row: typeof resources.$inferSelect): ResourceInput {
  return {
    name: row.name, role: row.role, hours: row.hours, slotMinutes: row.slotMinutes, feeCents: row.feeCents,
    about: row.about, categories: row.categories ?? null, isActive: row.isActive,
  };
}

// ── WhatsApp phone_number_id → business ────────────────────────────────────

export function isPhoneNumberId(s: unknown): s is string {
  return typeof s === 'string' && /^\d{5,30}$/.test(s);
}

/** The business mapped to a WhatsApp phone_number_id in D1, or null (lookup failures fall back). */
export async function businessForWhatsApp(env: Env, phoneNumberId: string): Promise<string | null> {
  try {
    const [row] = await getDb(env.DB).select({ businessType: whatsappNumbers.businessType }).from(whatsappNumbers)
      .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId)).limit(1);
    return row?.businessType ?? null;
  } catch (e: any) {
    console.error('[whatsapp-numbers] lookup failed', e?.message || e);
    return null;
  }
}

export async function listWhatsAppNumbers(env: Env) {
  return getDb(env.DB).select().from(whatsappNumbers).orderBy(asc(whatsappNumbers.businessType));
}

export async function upsertWhatsAppNumber(env: Env, phoneNumberId: string, businessType: string, label: string | null) {
  const now = new Date();
  await getDb(env.DB).insert(whatsappNumbers).values({ phoneNumberId, businessType, label, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: whatsappNumbers.phoneNumberId, set: { businessType, label, updatedAt: now } });
}

export async function deleteWhatsAppNumber(env: Env, phoneNumberId: string): Promise<boolean> {
  const rows = await getDb(env.DB).delete(whatsappNumbers).where(eq(whatsappNumbers.phoneNumberId, phoneNumberId))
    .returning({ id: whatsappNumbers.phoneNumberId });
  return rows.length > 0;
}

// ── Phone-number requests ──────────────────────────────────────────────────

export async function listNumberRequests(env: Env, businessType?: string) {
  const db = getDb(env.DB);
  const q = db.select().from(numberRequests);
  return (businessType ? q.where(eq(numberRequests.businessType, businessType)) : q)
    .orderBy(desc(numberRequests.createdAt)).limit(200);
}

/**
 * Records an owner's request for a phone number, once per business while
 * one is open. Emails ADMIN_NOTIFY_EMAIL when it and Resend are configured;
 * otherwise the operator sees it in admin Settings → Phone numbers.
 */
export async function requestNumber(env: Env, businessType: string, businessName: string, requestedBy: string | null, note: string | null) {
  const db = getDb(env.DB);
  const [open] = await db.select().from(numberRequests)
    .where(and(eq(numberRequests.businessType, businessType), eq(numberRequests.status, 'open'))).limit(1);
  if (open) return { row: open, created: false, emailed: false };
  const now = new Date();
  const [row] = await db.insert(numberRequests).values({
    id: crypto.randomUUID(), businessType, requestedBy, note, status: 'open', createdAt: now, updatedAt: now,
  }).returning();
  let emailed = false;
  const to = env.ADMIN_NOTIFY_EMAIL?.trim();
  if (to && env.RESEND_API_KEY && env.RESEND_API_KEY !== 'CHANGE_ME') {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? 'Avery <avery@mogi.ai>', to: [to],
          subject: `Phone number requested: ${businessName}`,
          text: `${businessName} (${businessType}) asked for a phone number.\nRequested by: ${requestedBy ?? 'unknown'}\n${note ? `Note: ${note}\n` : ''}\nConnect one in admin Settings → Phone numbers.`,
          html: `<p><b>${escapeHtml(businessName)}</b> (${escapeHtml(businessType)}) asked for a phone number.</p>` +
            `<p>Requested by: ${escapeHtml(requestedBy ?? 'unknown')}</p>${note ? `<p>Note: ${escapeHtml(note)}</p>` : ''}` +
            '<p>Connect one in admin Settings → Phone numbers.</p>',
        }),
      });
      emailed = res.ok;
      if (!res.ok) console.error('[number-request] email failed', res.status);
    } catch (e: any) {
      console.error('[number-request] email failed', e?.message || e);
    }
  }
  return { row, created: true, emailed };
}

export async function setNumberRequestStatus(env: Env, id: string, status: 'open' | 'done'): Promise<boolean> {
  const rows = await getDb(env.DB).update(numberRequests).set({ status, updatedAt: new Date() })
    .where(eq(numberRequests.id, id)).returning({ id: numberRequests.id });
  return rows.length > 0;
}
