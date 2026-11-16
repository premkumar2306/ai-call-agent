// Offers (coupons): a code that gives a business a longer free period and/or
// waives the plan's setup fee, e.g. FOUNDING25 for the first 25 clinics. The
// plan's price never changes: an offer only moves the first charge later and
// drops the one-off setup line. Seats are claimed with one conditional UPDATE,
// so two owners can't both take the last one.

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { billingAccounts, billingOffers } from '../../db/schema';
import type { Env } from '../../types';
import { getAccount, billingState } from './service';

export type Offer = typeof billingOffers.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function normalizeOfferCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9_-]{3,32}$/.test(c) ? c : null;
}

export async function getOffer(env: Env, code: string): Promise<Offer | null> {
  const [row] = await getDb(env.DB).select().from(billingOffers).where(eq(billingOffers.code, code));
  return row ?? null;
}

export async function listOffers(env: Env): Promise<Offer[]> {
  return getDb(env.DB).select().from(billingOffers).orderBy(billingOffers.code);
}

export function seatsLeft(o: Offer): number | null {
  return o.maxRedemptions == null ? null : Math.max(0, o.maxRedemptions - o.redeemed);
}

/** Why an offer can't be used for this plan now, or null if it can. */
export function offerProblem(o: Offer | null, planId: string | null, now = nowSec()): string | null {
  if (!o || !o.isActive) return 'That offer code is not valid';
  if (o.expiresAt && o.expiresAt <= now) return 'That offer has ended';
  if (o.maxRedemptions != null && o.redeemed >= o.maxRedemptions) return 'All places in that offer have been taken';
  const plans = (o.planIds ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (plans.length && (!planId || !plans.includes(planId))) return 'That offer is for a different plan';
  return null;
}

/** Public view of an offer (signup, pricing). */
export function publicOffer(o: Offer) {
  return {
    code: o.code, name: o.name, description: o.description, freeDays: o.freeDays, waiveSetupFee: o.waiveSetupFee,
    planIds: (o.planIds ?? '').split(',').map(s => s.trim()).filter(Boolean), seatsLeft: seatsLeft(o), expiresAt: o.expiresAt,
  };
}

/** Active offers with seats left, for signup and the pricing copy. */
export async function openOffers(env: Env) {
  const now = nowSec();
  return (await listOffers(env)).filter(o => o.isActive && (!o.expiresAt || o.expiresAt > now) && seatsLeft(o) !== 0).map(publicOffer);
}

/**
 * Applies an offer to a business on a plan, before it subscribes. Claims a
 * seat, records the code, and extends the free period to `freeDays` from now
 * (never shortens a longer trial). One offer per business.
 */
export async function applyOffer(env: Env, businessType: string, rawCode: unknown) {
  const code = normalizeOfferCode(rawCode);
  if (!code) throw httpError(400, 'Enter an offer code');
  const account = await getAccount(env, businessType);
  if (!account?.planId) throw httpError(409, 'Choose a plan first');
  if (account.offerCode) {
    if (account.offerCode === code) return account; // idempotent
    throw httpError(409, `Offer ${account.offerCode} is already applied`);
  }
  const state = billingState(account);
  if (account.razorpaySubscriptionId && account.subscriptionStatus && account.subscriptionStatus !== 'created') {
    throw httpError(409, 'Offers apply before you subscribe');
  }
  if (state === 'active' || state === 'past_due') throw httpError(409, 'Offers apply before you subscribe');
  const offer = await getOffer(env, code);
  const problem = offerProblem(offer, account.planId);
  if (problem) throw httpError(400, problem);

  const db = getDb(env.DB);
  const now = nowSec();
  // Claim a seat atomically (the WHERE re-checks the cap).
  const claim = await env.DB.prepare(
    `UPDATE billing_offers SET redeemed = redeemed + 1, updated_at = ?
     WHERE code = ? AND is_active = 1 AND (max_redemptions IS NULL OR redeemed < max_redemptions)`,
  ).bind(now, code).run();
  if (!claim.meta?.changes) throw httpError(400, 'All places in that offer have been taken');

  const freeUntil = offer!.freeDays > 0 ? now + offer!.freeDays * DAY : null;
  const trialEndsAt = freeUntil && (!account.trialEndsAt || account.trialEndsAt < freeUntil) ? freeUntil : account.trialEndsAt;
  const updated = await db.update(billingAccounts).set({
    offerCode: code, offerAppliedAt: now, trialEndsAt, updatedAt: now,
  }).where(and(eq(billingAccounts.businessType, businessType), sql`${billingAccounts.offerCode} IS NULL`)).returning();
  if (!updated.length) {
    // Lost a race with another apply on the same business: give the seat back.
    await db.update(billingOffers).set({ redeemed: sql`${billingOffers.redeemed} - 1` }).where(eq(billingOffers.code, code));
    throw httpError(409, 'An offer is already applied');
  }
  return updated[0];
}

export interface OfferInput {
  name: string; description?: string | null; freeDays?: number; waiveSetupFee?: boolean; planIds?: string | null;
  maxRedemptions?: number | null; expiresAt?: number | null; isActive?: boolean;
}

export function validateOfferInput(b: any): OfferInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  if (typeof b.name !== 'string' || !b.name.trim()) return 'name is required';
  const intOrNull = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
  for (const k of ['freeDays', 'maxRedemptions', 'expiresAt']) if (!intOrNull(b[k])) return `${k} must be a non-negative integer`;
  if (b.freeDays != null && b.freeDays > 366) return 'freeDays must be 366 or less';
  if (b.planIds != null && (typeof b.planIds !== 'string' || !/^[a-z0-9_,\s-]*$/.test(b.planIds))) return 'planIds must be comma-separated plan ids';
  return {
    name: b.name.trim(), description: typeof b.description === 'string' ? b.description.trim() : null,
    freeDays: b.freeDays ?? 0, waiveSetupFee: b.waiveSetupFee === true, planIds: b.planIds || null,
    maxRedemptions: b.maxRedemptions ?? null, expiresAt: b.expiresAt ?? null, isActive: b.isActive !== false,
  };
}

export async function upsertOffer(env: Env, code: string, o: OfferInput): Promise<Offer> {
  const now = nowSec();
  const values = {
    name: o.name, description: o.description ?? null, freeDays: o.freeDays ?? 0, waiveSetupFee: !!o.waiveSetupFee,
    planIds: o.planIds ?? null, maxRedemptions: o.maxRedemptions ?? null, expiresAt: o.expiresAt ?? null,
    isActive: o.isActive !== false, updatedAt: now,
  };
  await getDb(env.DB).insert(billingOffers).values({ code, ...values, createdAt: now })
    .onConflictDoUpdate({ target: billingOffers.code, set: values });
  return (await getOffer(env, code))!;
}
