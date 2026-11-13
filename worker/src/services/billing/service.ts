import { and, eq, isNotNull, ne, or, isNull, sql, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { billingAccounts, billingInvoices, billingPlans, sectors, usageRecords } from '../../db/schema';
import type { Env } from '../../types';
import { getSector } from '../sector.service';
import { sendEmail } from '../notify.service';
import {
  billableMinutes, billingPeriod, computeOverage, costParts, costRates, estimateCostUsdMicros, formatInr,
  gstinStateCode, graceDays, previousPeriod, splitGst, usageAlertLevel, usdMicrosToPaise, withGst, gstOn,
  type LlmUsage,
} from './pricing';
import * as razorpay from './razorpay';
import { listTaxInvoices } from './invoices';

export type Plan = typeof billingPlans.$inferSelect;
export type Account = typeof billingAccounts.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Billing state ───────────────────────────────────────────────────────────

export type BillingState =
  | 'off'        // no plan: nothing is billed (the default for every business)
  | 'trialing'   // inside the free trial, not subscribed yet
  | 'active'     // Razorpay subscription authenticated (mandate set up) or active
  | 'past_due'   // a charge failed (subscription pending/halted, or payment.failed)
  | 'paused'     // subscription paused in Razorpay
  | 'cancelled'  // subscription cancelled/completed/expired
  | 'unpaid';    // trial over and no subscription yet

type StateFields = Pick<Account, 'planId' | 'trialEndsAt' | 'subscriptionStatus'> & Partial<Pick<Account, 'pastDueSince'>>;

/**
 * Pure: what the owner sees as their billing status. Razorpay's statuses:
 * created (Checkout not finished), authenticated (mandate set up; first charge
 * at start_at, e.g. trial end), active, pending (a charge failed; Razorpay
 * retries), halted (retries exhausted), paused, cancelled, completed, expired.
 * Never blocks calls.
 */
export function billingState(account: StateFields | null | undefined, now = nowSec()): BillingState {
  if (!account?.planId) return 'off';
  switch (account.subscriptionStatus) {
    case 'authenticated': case 'active': case 'resumed': return account.pastDueSince ? 'past_due' : 'active';
    case 'pending': case 'halted': return 'past_due';
    case 'paused': return 'paused';
    case 'cancelled': case 'completed': case 'expired': return 'cancelled';
  }
  if (account.trialEndsAt && account.trialEndsAt > now) return 'trialing';
  return 'unpaid';
}

export interface Entitlements {
  /** Minutes beyond the plan are billed. False = "restricted": the assistant keeps answering, extra minutes aren't charged. */
  overageAllowed: boolean;
  restricted: boolean;
  /** When a past-due or unpaid account becomes restricted (unix seconds). */
  graceEndsAt: number | null;
}

/**
 * Pure: what a billing state still allows. Nothing here ever stops a call or
 * the assistant: a restricted account just stops accruing (and being charged)
 * overage until payment is fixed. A failed payment gets `graceDays` first; a
 * halted subscription (Razorpay gave up retrying) is restricted at once.
 */
export function entitlements(account: StateFields | null | undefined, graceDays: number, now = nowSec()): Entitlements {
  const state = billingState(account, now);
  const grace = graceDays * 86_400;
  if (state === 'past_due') {
    const graceEndsAt = (account!.pastDueSince ?? now) + grace;
    const restricted = account!.subscriptionStatus === 'halted' || now >= graceEndsAt;
    return { overageAllowed: !restricted, restricted, graceEndsAt };
  }
  if (state === 'unpaid') {
    const graceEndsAt = (account!.trialEndsAt ?? now) + grace;
    const restricted = now >= graceEndsAt;
    return { overageAllowed: !restricted, restricted, graceEndsAt };
  }
  if (state === 'paused' || state === 'cancelled') return { overageAllowed: false, restricted: true, graceEndsAt: null };
  return { overageAllowed: true, restricted: false, graceEndsAt: null };
}

// ── Plans ───────────────────────────────────────────────────────────────────

export async function listPlans(env: Env): Promise<Plan[]> {
  return getDb(env.DB).select().from(billingPlans).orderBy(billingPlans.monthlyFeePaise);
}

export async function getPlan(env: Env, id: string): Promise<Plan | null> {
  const [row] = await getDb(env.DB).select().from(billingPlans).where(eq(billingPlans.id, id));
  return row ?? null;
}

export interface PlanInput {
  name: string; currency?: string; monthlyFeePaise: number; includedMinutes: number;
  overagePaisePerMinute: number; trialDays?: number; gstRateBps?: number; isActive?: boolean; isDefault?: boolean;
  razorpayPlanId?: string | null;
}

export function validatePlanInput(b: any): PlanInput | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (typeof b.name !== 'string' || !b.name.trim()) return 'name is required';
  for (const k of ['monthlyFeePaise', 'includedMinutes', 'overagePaisePerMinute']) {
    if (!int(b[k])) return `${k} must be a non-negative integer`;
  }
  for (const k of ['trialDays', 'gstRateBps']) {
    if (b[k] !== undefined && !int(b[k])) return `${k} must be a non-negative integer`;
  }
  if (b.currency !== undefined && !/^[A-Z]{3}$/.test(b.currency)) return 'currency must be an ISO code like INR';
  return {
    name: b.name.trim(), currency: b.currency, monthlyFeePaise: b.monthlyFeePaise,
    includedMinutes: b.includedMinutes, overagePaisePerMinute: b.overagePaisePerMinute,
    trialDays: b.trialDays, gstRateBps: b.gstRateBps,
    isActive: typeof b.isActive === 'boolean' ? b.isActive : undefined,
    isDefault: typeof b.isDefault === 'boolean' ? b.isDefault : undefined,
    razorpayPlanId: typeof b.razorpayPlanId === 'string' || b.razorpayPlanId === null ? b.razorpayPlanId : undefined,
  };
}

export async function upsertPlan(env: Env, id: string, p: PlanInput): Promise<Plan> {
  const db = getDb(env.DB);
  const now = nowSec();
  const values = {
    name: p.name, currency: p.currency ?? 'INR', monthlyFeePaise: p.monthlyFeePaise,
    includedMinutes: p.includedMinutes, overagePaisePerMinute: p.overagePaisePerMinute,
    trialDays: p.trialDays ?? 0, gstRateBps: p.gstRateBps ?? 1800, isActive: p.isActive ?? true,
    ...(p.razorpayPlanId !== undefined ? { razorpayPlanId: p.razorpayPlanId } : {}),
    ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {}),
    updatedAt: now,
  };
  // At most one default plan.
  if (p.isDefault) await db.update(billingPlans).set({ isDefault: false, updatedAt: now }).where(ne(billingPlans.id, id));
  await db.insert(billingPlans).values({ id, ...values, createdAt: now })
    .onConflictDoUpdate({ target: billingPlans.id, set: values });
  return (await getPlan(env, id))!;
}

/** Creates the monthly plan in Razorpay (fee incl. GST) and stores its id. */
export async function syncPlanToRazorpay(env: Env, id: string): Promise<Plan> {
  const plan = await getPlan(env, id);
  if (!plan) throw Object.assign(new Error(`Unknown plan ${id}`), { status: 404 });
  const rp = await razorpay.createPlan(env, {
    name: plan.name,
    amountPaise: withGst(plan.monthlyFeePaise, plan.gstRateBps),
    currency: plan.currency,
    description: `${plan.includedMinutes} minutes included; ${formatInr(plan.overagePaisePerMinute)}/min after (+GST). Amount incl. ${plan.gstRateBps / 100}% GST.`,
    notes: { avery_plan_id: plan.id },
  });
  await getDb(env.DB).update(billingPlans).set({ razorpayPlanId: rp.id, updatedAt: nowSec() }).where(eq(billingPlans.id, id));
  return (await getPlan(env, id))!;
}

// ── Accounts ────────────────────────────────────────────────────────────────

export async function getAccount(env: Env, businessType: string): Promise<Account | null> {
  const [row] = await getDb(env.DB).select().from(billingAccounts).where(eq(billingAccounts.businessType, businessType));
  return row ?? null;
}

/**
 * Turns billing on (planId) or off (null) for a business. The free trial
 * starts the first time a plan is assigned and is not reset by plan changes.
 */
export async function assignPlan(env: Env, businessType: string, planId: string | null): Promise<Account> {
  const db = getDb(env.DB);
  const now = nowSec();
  let trialEndsAt: number | null = null;
  if (planId) {
    const plan = await getPlan(env, planId);
    if (!plan) throw Object.assign(new Error(`Unknown plan ${planId}`), { status: 404 });
    trialEndsAt = plan.trialDays > 0 ? now + plan.trialDays * 86_400 : null;
  }
  const existing = await getAccount(env, businessType);
  if (existing) {
    const unpaidCheckout = existing.subscriptionStatus === 'created' && existing.planId !== planId;
    await db.update(billingAccounts).set({
      planId,
      ...(existing.trialEndsAt == null && !existing.razorpaySubscriptionId && planId ? { trialEndsAt } : {}),
      // A Checkout that was opened for the old plan and never paid is dropped; Subscribe creates a new one.
      ...(unpaidCheckout ? { razorpaySubscriptionId: null, subscriptionStatus: null } : {}),
      pendingPlanId: null,
      updatedAt: now,
    }).where(eq(billingAccounts.businessType, businessType));
  } else {
    await db.insert(billingAccounts).values({ businessType, planId, trialEndsAt, createdAt: now, updatedAt: now });
  }
  return (await getAccount(env, businessType))!;
}

/**
 * Puts a new business on the plan marked default, with its free trial, so
 * it shows up in billing from day one. Nothing is charged until the owner
 * subscribes. No default plan (the starting state) = billing stays off.
 */
export async function assignDefaultPlan(env: Env, businessType: string): Promise<Account | null> {
  // Plans are in INR with GST: only Indian businesses start on one. A US
  // business stays exactly as it was (billing off).
  const country = (await getSector(env, businessType))?.countryCode ?? 'US';
  if (country !== 'IN') return null;
  const [plan] = await getDb(env.DB).select().from(billingPlans)
    .where(and(eq(billingPlans.isDefault, true), eq(billingPlans.isActive, true))).limit(1);
  if (!plan || await getAccount(env, businessType)) return null;
  return assignPlan(env, businessType, plan.id);
}

export interface BillingDetails {
  legalName?: string | null; gstin?: string | null; billingEmail?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null;
  state?: string | null; postalCode?: string | null; country?: string;
}

export async function updateBillingDetails(env: Env, businessType: string, d: BillingDetails): Promise<Account> {
  const db = getDb(env.DB);
  const now = nowSec();
  if (!(await getAccount(env, businessType))) {
    await db.insert(billingAccounts).values({ businessType, createdAt: now, updatedAt: now });
  }
  await db.update(billingAccounts).set({ ...d, updatedAt: now }).where(eq(billingAccounts.businessType, businessType));
  return (await getAccount(env, businessType))!;
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface UsageInput {
  businessType: string;
  channel: 'voice' | 'whatsapp';
  provider?: string | null;
  sttProvider?: string | null;
  ttsProvider?: string | null;
  sourceId: string;
  startedAt: number;     // unix seconds
  endedAt?: number;
  durationSeconds?: number;
  sttSeconds?: number;
  ttsChars?: number;
  llmModel?: string | null;
  llm?: LlmUsage;
  billable?: boolean;    // false for synthetic test calls
}

/**
 * Writes one usage record (idempotent on channel + sourceId) and sends the
 * 80%/100% soft-limit emails. Always called off the call path (waitUntil);
 * never throws.
 */
export async function recordUsage(env: Env, u: UsageInput): Promise<void> {
  try {
    const duration = Math.max(0, Math.round(u.durationSeconds ?? 0));
    const billable = u.billable !== false;
    const llm = u.llm ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const sttSeconds = Math.max(0, Math.round(u.sttSeconds ?? 0));
    const ttsChars = u.ttsChars ?? 0;
    const period = billingPeriod(new Date(u.startedAt * 1000));
    const cost = estimateCostUsdMicros({
      channel: u.channel, provider: u.provider, sttProvider: u.sttProvider, ttsProvider: u.ttsProvider,
      durationSeconds: duration, sttSeconds, ttsChars, llmModel: u.llmModel, llm,
    }, costRates(env.BILLING_COST_RATES));
    await getDb(env.DB).insert(usageRecords).values({
      id: crypto.randomUUID(),
      businessType: u.businessType, channel: u.channel, provider: u.provider ?? null, sourceId: u.sourceId,
      period, startedAt: u.startedAt, endedAt: u.endedAt ?? null,
      durationSeconds: duration,
      billableMinutes: billable && u.channel === 'voice' ? billableMinutes(duration) : 0,
      billable, sttSeconds, ttsChars, llmModel: u.llmModel ?? null,
      llmInputTokens: llm.input, llmOutputTokens: llm.output,
      llmCacheReadTokens: llm.cacheRead, llmCacheWriteTokens: llm.cacheWrite,
      costUsdMicros: cost, createdAt: nowSec(),
    }).onConflictDoNothing();
    if (billable && u.channel === 'voice') await checkUsageAlerts(env, u.businessType, period);
  } catch (e: any) {
    console.error('[billing] recordUsage failed', u.businessType, u.sourceId, e?.message || e);
  }
}

/** Adds LLM tokens to an existing record (a WhatsApp conversation spans many messages). */
export async function addLlmUsage(env: Env, channel: 'voice' | 'whatsapp', sourceId: string, model: string, llm: LlmUsage): Promise<void> {
  try {
    const db = getDb(env.DB);
    const [row] = await db.select().from(usageRecords).where(and(eq(usageRecords.channel, channel), eq(usageRecords.sourceId, sourceId)));
    if (!row) return;
    const next = {
      input: row.llmInputTokens + llm.input, output: row.llmOutputTokens + llm.output,
      cacheRead: row.llmCacheReadTokens + llm.cacheRead, cacheWrite: row.llmCacheWriteTokens + llm.cacheWrite,
    };
    const cost = estimateCostUsdMicros({
      channel, provider: row.provider, durationSeconds: row.durationSeconds, sttSeconds: row.sttSeconds,
      ttsChars: row.ttsChars, llmModel: model, llm: next,
    }, costRates(env.BILLING_COST_RATES));
    await db.update(usageRecords).set({
      llmModel: model, llmInputTokens: next.input, llmOutputTokens: next.output,
      llmCacheReadTokens: next.cacheRead, llmCacheWriteTokens: next.cacheWrite, costUsdMicros: cost,
    }).where(eq(usageRecords.id, row.id));
  } catch (e: any) {
    console.error('[billing] addLlmUsage failed', sourceId, e?.message || e);
  }
}

export interface PeriodUsage {
  period: string;
  minutes: number;
  calls: number;
  callSeconds: number;
  whatsappConversations: number;
  costUsdMicros: number;
  testCalls: number;
}

export async function periodUsage(env: Env, businessType: string, period: string): Promise<PeriodUsage> {
  const [row] = await getDb(env.DB).select({
    minutes: sql<number>`coalesce(sum(case when ${usageRecords.channel} = 'voice' then ${usageRecords.billableMinutes} else 0 end), 0)`,
    calls: sql<number>`coalesce(sum(case when ${usageRecords.channel} = 'voice' and ${usageRecords.billable} = 1 then 1 else 0 end), 0)`,
    callSeconds: sql<number>`coalesce(sum(case when ${usageRecords.channel} = 'voice' and ${usageRecords.billable} = 1 then ${usageRecords.durationSeconds} else 0 end), 0)`,
    whatsappConversations: sql<number>`coalesce(sum(case when ${usageRecords.channel} = 'whatsapp' then 1 else 0 end), 0)`,
    costUsdMicros: sql<number>`coalesce(sum(${usageRecords.costUsdMicros}), 0)`,
    testCalls: sql<number>`coalesce(sum(case when ${usageRecords.billable} = 0 then 1 else 0 end), 0)`,
  }).from(usageRecords).where(and(eq(usageRecords.businessType, businessType), eq(usageRecords.period, period)));
  return {
    period,
    minutes: Number(row?.minutes ?? 0), calls: Number(row?.calls ?? 0), callSeconds: Number(row?.callSeconds ?? 0),
    whatsappConversations: Number(row?.whatsappConversations ?? 0),
    costUsdMicros: Number(row?.costUsdMicros ?? 0), testCalls: Number(row?.testCalls ?? 0),
  };
}

export async function usageRecordsFor(env: Env, businessType: string, period: string, limit = 500) {
  return getDb(env.DB).select().from(usageRecords)
    .where(and(eq(usageRecords.businessType, businessType), eq(usageRecords.period, period)))
    .orderBy(desc(usageRecords.startedAt)).limit(limit);
}

// ── Soft limits ─────────────────────────────────────────────────────────────
// Emails only. Calls are never refused or cut off for being over the plan:
// minutes beyond it are billed as overage at month end.

async function billingContactEmail(env: Env, account: Account): Promise<string | null> {
  return account.billingEmail || (await getSector(env, account.businessType))?.notifyEmail || null;
}

export async function checkUsageAlerts(env: Env, businessType: string, period: string): Promise<void> {
  const account = await getAccount(env, businessType);
  if (!account?.planId) return; // billing off
  const plan = await getPlan(env, account.planId);
  if (!plan) return;
  const usage = await periodUsage(env, businessType, period);
  const level = usageAlertLevel(usage.minutes, plan.includedMinutes);
  if (!level) return;

  const db = getDb(env.DB);
  // Claim the alert with a conditional update so concurrent call-ends send it once.
  const claim = async (col: typeof billingAccounts.alert80Period | typeof billingAccounts.alert100Period, field: 'alert80Period' | 'alert100Period') => {
    const r = await db.update(billingAccounts).set({ [field]: period, updatedAt: nowSec() })
      .where(and(eq(billingAccounts.businessType, businessType), or(isNull(col), ne(col, period))))
      .run();
    return (r as any).meta?.changes > 0;
  };
  const to = await billingContactEmail(env, account);
  const name = (await getSector(env, businessType))?.name ?? businessType;

  if (level === 100) {
    // Reaching 100% first also satisfies the 80% alert for this period.
    await claim(billingAccounts.alert80Period, 'alert80Period');
    if (!(await claim(billingAccounts.alert100Period, 'alert100Period')) || !to) return;
    await sendEmail(env, to, `${name}: you've used all ${plan.includedMinutes} included minutes`,
      `Your AI receptionist has answered ${usage.minutes} minutes of calls this month (${period}), ` +
      `which uses all ${plan.includedMinutes} minutes in your ${plan.name} plan.\n\n` +
      `Calls keep being answered as normal. Extra minutes are billed at ${formatInr(plan.overagePaisePerMinute)}/minute ` +
      `+ ${plan.gstRateBps / 100}% GST at the end of the month.\n`,
    ).catch(e => console.error('[billing] 100% email failed', e?.message || e));
  } else {
    if (!(await claim(billingAccounts.alert80Period, 'alert80Period')) || !to) return;
    await sendEmail(env, to, `${name}: 80% of your included minutes used`,
      `Your AI receptionist has answered ${usage.minutes} of the ${plan.includedMinutes} minutes included in your ` +
      `${plan.name} plan this month (${period}).\n\nCalls keep being answered as normal. Minutes beyond the plan are billed at ` +
      `${formatInr(plan.overagePaisePerMinute)}/minute + ${plan.gstRateBps / 100}% GST at the end of the month.\n`,
    ).catch(e => console.error('[billing] 80% email failed', e?.message || e));
  }
}

// ── Summary (Billing tab) ───────────────────────────────────────────────────

export interface Viewer { role: 'operator' | 'owner' }

export async function billingSummary(env: Env, businessType: string, viewer: Viewer, period = billingPeriod(new Date())) {
  const account = await getAccount(env, businessType);
  const plan = account?.planId ? await getPlan(env, account.planId) : null;
  const usage = await periodUsage(env, businessType, period);
  const invoices = await getDb(env.DB).select().from(billingInvoices)
    .where(eq(billingInvoices.businessType, businessType)).orderBy(desc(billingInvoices.period)).limit(12);

  const supplierState = gstinStateCode(env.BILLING_SUPPLIER_GSTIN);
  const customerState = gstinStateCode(account?.gstin);
  const gstBreakdown = (amount: number, rate: number) => {
    const gst = gstOn(amount, rate);
    return { amountPaise: amount, gstPaise: gst, totalPaise: amount + gst, ...splitGst(gst, supplierState, customerState) };
  };

  const overage = plan ? computeOverage(plan, usage.minutes) : null;
  const rates = costRates(env.BILLING_COST_RATES);

  const now = nowSec();
  const state = billingState(account, now);
  const ent = entitlements(account, graceDays(env.BILLING_GRACE_DAYS), now);
  const pendingPlan = account?.pendingPlanId ? await getPlan(env, account.pendingPlanId) : null;
  const plans = await listPlans(env);
  const bigger = plan ? plans.find(p => p.isActive && p.monthlyFeePaise > plan.monthlyFeePaise) : null;
  const alertLevel = plan ? usageAlertLevel(usage.minutes, plan.includedMinutes) : 0;
  const tax = await listTaxInvoices(env, businessType);

  // When Razorpay charges next: the trial's end for a mandate set up during
  // the trial, else the end of the current cycle. Nothing after cancellation.
  let nextCharge: { at: number; amountPaise: number } | null = null;
  if (plan && (state === 'active' || state === 'past_due') && !account?.cancelAtPeriodEnd) {
    const at = account?.subscriptionStatus === 'authenticated' && account.trialEndsAt && account.trialEndsAt > now
      ? account.trialEndsAt : account?.currentPeriodEnd ?? null;
    const nextPlan = pendingPlan ?? plan;
    if (at) nextCharge = { at, amountPaise: withGst(nextPlan.monthlyFeePaise, nextPlan.gstRateBps) };
  }
  const nextAction: 'subscribe' | 'update_payment' | 'upgrade' | null =
    !plan ? null
    : state === 'past_due' ? (account?.subscriptionStatus === 'halted' ? 'subscribe' : 'update_payment')
    : ['trialing', 'unpaid', 'cancelled'].includes(state) ? 'subscribe'
    : state === 'active' && alertLevel >= 80 && bigger ? 'upgrade'
    : null;

  const summary: Record<string, unknown> = {
    businessType,
    state,
    nextAction,
    trialDaysLeft: state === 'trialing' && account?.trialEndsAt ? Math.max(0, Math.ceil((account.trialEndsAt - now) / 86_400)) : null,
    nextCharge,
    payment: account && {
      lastStatus: account.lastPaymentStatus, lastAt: account.lastPaymentAt, lastError: account.lastPaymentError,
      pastDueSince: account.pastDueSince, graceEndsAt: ent.graceEndsAt,
    },
    overageAllowed: ent.overageAllowed,
    cancelAtPeriodEnd: !!account?.cancelAtPeriodEnd,
    pendingPlan: pendingPlan && { id: pendingPlan.id, name: pendingPlan.name },
    upgradeTo: bigger && { id: bigger.id, name: bigger.name },
    taxInvoices: tax.map(t => ({
      id: t.id, number: t.invoiceNumber, issuedAt: t.issuedAt, taxablePaise: t.taxablePaise,
      cgst: t.cgstPaise, sgst: t.sgstPaise, igst: t.igstPaise, totalPaise: t.totalPaise, refundedPaise: t.refundedPaise,
    })),
    razorpayConfigured: razorpay.razorpayConfigured(env),
    razorpayKeyId: env.RAZORPAY_KEY_ID ?? null, // public key id, needed by Checkout
    plan: plan && {
      id: plan.id, name: plan.name, currency: plan.currency, includedMinutes: plan.includedMinutes,
      overagePaisePerMinute: plan.overagePaisePerMinute, trialDays: plan.trialDays, gstRateBps: plan.gstRateBps,
      monthly: gstBreakdown(plan.monthlyFeePaise, plan.gstRateBps),
      checkoutReady: !!plan.razorpayPlanId,
    },
    account: account && {
      trialEndsAt: account.trialEndsAt, subscriptionId: account.razorpaySubscriptionId,
      subscriptionStatus: account.subscriptionStatus, currentPeriodEnd: account.currentPeriodEnd,
      legalName: account.legalName, gstin: account.gstin, billingEmail: account.billingEmail,
      addressLine1: account.addressLine1, addressLine2: account.addressLine2, city: account.city,
      state: account.state, postalCode: account.postalCode, country: account.country,
    },
    supplierGstin: env.BILLING_SUPPLIER_GSTIN ?? null,
    usage: {
      period, minutes: usage.minutes, calls: usage.calls, whatsappConversations: usage.whatsappConversations,
      includedMinutes: plan?.includedMinutes ?? null,
      alertLevel,
      overageSoFar: overage && plan && { minutes: overage.overageMinutes, ...gstBreakdown(overage.overagePaise, plan.gstRateBps) },
    },
    invoices: invoices.map(i => ({
      period: i.period, status: i.status, minutesUsed: i.minutesUsed, includedMinutes: i.includedMinutes,
      overageMinutes: i.overageMinutes, amountPaise: i.overagePaise, gstPaise: i.gstPaise, totalPaise: i.totalPaise,
      ...splitGst(i.gstPaise, supplierState, customerState),
    })),
  };

  // Provider cost and margin are the operator's business, never the owner's.
  if (viewer.role === 'operator') {
    const costPaise = usdMicrosToPaise(usage.costUsdMicros, rates);
    const revenuePaise = plan ? plan.monthlyFeePaise + (overage?.overagePaise ?? 0) : 0;
    summary.cost = {
      usdToInr: rates.usdToInr,
      costUsdMicros: usage.costUsdMicros,
      costPaise,
      costPerMinutePaise: usage.minutes ? Math.round(costPaise / usage.minutes) : null,
      revenuePaise,               // excl. GST, if the month ended now
      revenuePerMinutePaise: usage.minutes && plan ? Math.round(revenuePaise / usage.minutes) : null,
      marginPaise: plan ? revenuePaise - costPaise : null,
      testCalls: usage.testCalls,
    };
  }
  return summary;
}

// ── Razorpay subscription (checkout) ────────────────────────────────────────

// Monthly cycles before Razorpay marks the subscription completed (10 years).
const SUBSCRIPTION_CYCLES = 120;

export interface CheckoutStart {
  subscriptionId: string; keyId: string; shortUrl?: string;
  prefill: { name?: string; email?: string; contact?: string };
  description: string;
}

export async function startSubscription(env: Env, businessType: string): Promise<CheckoutStart> {
  const account = await getAccount(env, businessType);
  if (!account?.planId) throw Object.assign(new Error('Billing is not enabled for this business'), { status: 409 });
  const plan = await getPlan(env, account.planId);
  if (!plan?.razorpayPlanId) throw Object.assign(new Error('Plan is not set up in Razorpay yet'), { status: 409 });
  if (!razorpay.razorpayConfigured(env)) throw new razorpay.RazorpayNotConfigured();

  const sector = await getSector(env, businessType);
  const extra = {
    prefill: {
      name: account.legalName || sector?.name || undefined,
      email: account.billingEmail || sector?.notifyEmail || undefined,
      contact: sector?.phone || undefined,
    },
    description: `${plan.name} plan: ${formatInr(withGst(plan.monthlyFeePaise, plan.gstRateBps))}/month incl. GST`,
  };
  // Re-use a subscription that hasn't been paid for yet (the owner closed Checkout).
  if (account.razorpaySubscriptionId && (account.subscriptionStatus === 'created' || !account.subscriptionStatus)) {
    return { subscriptionId: account.razorpaySubscriptionId, keyId: env.RAZORPAY_KEY_ID!, ...extra };
  }
  const state = billingState(account);
  if (state === 'active') throw Object.assign(new Error('Already subscribed'), { status: 409 });
  if (state === 'past_due' && account.subscriptionStatus !== 'halted') {
    throw Object.assign(new Error('A payment is overdue: use Update payment instead'), { status: 409 });
  }

  const now = nowSec();
  // First charge after the trial; Razorpay needs start_at comfortably in the future.
  const startAt = account.trialEndsAt && account.trialEndsAt > now + 3600 ? account.trialEndsAt : undefined;
  const sub = await razorpay.createSubscription(env, {
    planId: plan.razorpayPlanId, totalCount: SUBSCRIPTION_CYCLES, startAt,
    notes: { business_type: businessType, avery_plan_id: plan.id },
  });
  // A halted subscription can't be revived by Checkout: it is replaced (Razorpay keeps its history).
  if (account.razorpaySubscriptionId && account.subscriptionStatus === 'halted') {
    await razorpay.cancelSubscription(env, account.razorpaySubscriptionId, false)
      .catch(e => console.error('[billing] could not cancel halted subscription', e?.message || e));
  }
  await getDb(env.DB).update(billingAccounts).set({
    razorpaySubscriptionId: sub.id, subscriptionStatus: sub.status, cancelAtPeriodEnd: false, updatedAt: now,
  }).where(eq(billingAccounts.businessType, businessType));
  return { subscriptionId: sub.id, keyId: env.RAZORPAY_KEY_ID!, shortUrl: sub.short_url, ...extra };
}

/**
 * Checkout's success handler posts the payment id, subscription id and
 * signature. A valid signature marks the subscription authenticated right
 * away; the webhook remains the source of truth for later status changes.
 */
export async function confirmCheckout(env: Env, businessType: string, p: { paymentId: string; subscriptionId: string; signature: string }): Promise<boolean> {
  const account = await getAccount(env, businessType);
  if (!account || account.razorpaySubscriptionId !== p.subscriptionId) return false;
  if (!(await razorpay.verifyCheckoutSignature(env, p.paymentId, p.subscriptionId, p.signature))) return false;
  if (!account.subscriptionStatus || account.subscriptionStatus === 'created') {
    await getDb(env.DB).update(billingAccounts).set({
      subscriptionStatus: 'authenticated', pastDueSince: null, lastPaymentStatus: 'captured', lastPaymentError: null, updatedAt: nowSec(),
    }).where(eq(billingAccounts.businessType, businessType));
  }
  return true;
}

// ── Month-end close ─────────────────────────────────────────────────────────

/**
 * Bills last month's overage for every business with a plan: an add-on on its
 * Razorpay subscription (charged with the next monthly invoice), amount incl.
 * GST. One billing_invoices row per business per period makes this safe to
 * run daily and by hand; failed rows are retried on the next run.
 */
export async function closePeriod(env: Env, period = previousPeriod(billingPeriod(new Date()))): Promise<Array<{ businessType: string; status: string; error?: string }>> {
  const db = getDb(env.DB);
  const accounts = await db.select().from(billingAccounts).where(isNotNull(billingAccounts.planId));
  const results: Array<{ businessType: string; status: string; error?: string }> = [];
  const periodEnd = periodEndUnix(period);
  const grace = graceDays(env.BILLING_GRACE_DAYS);

  for (const account of accounts) {
    const [existing] = await db.select().from(billingInvoices)
      .where(and(eq(billingInvoices.businessType, account.businessType), eq(billingInvoices.period, period)));
    if (existing && !RETRYABLE.includes(existing.status)) continue;

    const plan = await getPlan(env, account.planId!);
    if (!plan) continue;
    const usage = await periodUsage(env, account.businessType, period);
    const o = computeOverage(plan, usage.minutes);
    const status = overageDecision(account, o.overagePaise, periodEnd, grace);

    const now = nowSec();
    const row = {
      planId: plan.id, minutesUsed: o.minutesUsed, includedMinutes: o.includedMinutes, overageMinutes: o.overageMinutes,
      overagePaise: o.overagePaise, gstPaise: o.gstPaise, totalPaise: o.totalPaise,
      status, razorpayAddonId: null as string | null, error: null as string | null, updatedAt: now,
    };
    if (status !== 'bill') {
      await saveInvoiceRow(env, existing?.id, account.businessType, period, row);
      results.push({ businessType: account.businessType, status });
      continue;
    }

    // Claim the month before calling Razorpay ('billing'), so a crash or a
    // second run can never add the same add-on twice. A row stuck in
    // 'billing' is left for the operator rather than retried.
    const id = await saveInvoiceRow(env, existing?.id, account.businessType, period, { ...row, status: 'billing' });
    try {
      const addon = await razorpay.createAddon(env, account.razorpaySubscriptionId!, {
        name: `Extra minutes ${period}`,
        description: `${o.overageMinutes} min over ${plan.includedMinutes} @ ${formatInr(plan.overagePaisePerMinute)} + ${plan.gstRateBps / 100}% GST`,
        amountPaise: o.totalPaise, currency: plan.currency,
      });
      await db.update(billingInvoices).set({ status: 'billed', razorpayAddonId: addon.id, updatedAt: nowSec() }).where(eq(billingInvoices.id, id));
      results.push({ businessType: account.businessType, status: 'billed' });
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 500);
      await db.update(billingInvoices).set({ status: 'failed', error, updatedAt: nowSec() }).where(eq(billingInvoices.id, id));
      results.push({ businessType: account.businessType, status: 'failed', error });
    }
  }
  return results;
}

/** Month rows retried by the next daily run. */
const RETRYABLE = ['failed', 'deferred'];

/** Unix seconds of the end of a 'YYYY-MM' period: midnight India time on the 1st of the next month. */
export function periodEndUnix(period: string): number {
  const [py, pm] = period.split('-').map(Number);
  return Math.floor(Date.UTC(pm === 12 ? py + 1 : py, pm === 12 ? 0 : pm, 1) / 1000) - 19_800;
}

/**
 * Pure: what month-end does with a business's overage.
 *   no_overage — within the plan
 *   trial      — the free trial covered the whole month
 *   waived     — payment overdue past the grace period (or paused/cancelled): extra minutes aren't charged
 *   deferred   — payment overdue, still in grace (or trial just ended, not subscribed yet): retried daily
 *   unbilled   — no subscription to bill
 *   bill       — add it to the subscription's next invoice
 */
export function overageDecision(account: Account, overagePaise: number, periodEnd: number, grace: number, now = nowSec()):
  'no_overage' | 'trial' | 'waived' | 'deferred' | 'unbilled' | 'bill' {
  if (overagePaise === 0) return 'no_overage';
  if (account.trialEndsAt && account.trialEndsAt >= periodEnd) return 'trial';
  const state = billingState(account, now);
  if (entitlements(account, grace, now).restricted) return 'waived';
  if (state === 'past_due' || state === 'unpaid') return 'deferred';
  if (state !== 'active' || !account.razorpaySubscriptionId) return 'unbilled';
  return 'bill';
}

async function saveInvoiceRow(env: Env, existingId: string | undefined, businessType: string, period: string, row: Partial<typeof billingInvoices.$inferInsert>): Promise<string> {
  const db = getDb(env.DB);
  if (existingId) {
    await db.update(billingInvoices).set(row).where(eq(billingInvoices.id, existingId));
    return existingId;
  }
  const id = crypto.randomUUID();
  await db.insert(billingInvoices).values({ id, businessType, period, createdAt: nowSec(), ...row } as typeof billingInvoices.$inferInsert);
  return id;
}

// ── In-app test calls ───────────────────────────────────────────────────────
// "Try your assistant" (/mogi/voice-turn) uses the same AI model as a phone
// call but no phone line. Its cost is recorded, never billed.

export async function recordTestTurn(env: Env, businessType: string, sourceId: string, startedAt: number, model: string, llm: LlmUsage): Promise<void> {
  try {
    await recordUsage(env, { businessType, channel: 'voice', provider: 'web', sourceId, startedAt, billable: false });
    await addLlmUsage(env, 'voice', sourceId, model, llm);
  } catch (e: any) {
    console.error('[billing] recordTestTurn failed', e?.message || e);
  }
}

// ── Cost per call (operator) ────────────────────────────────────────────────
// Each call's estimated provider cost (phone line, speech, AI model), the share
// of revenue it brought in, and the margin. Revenue: billable minutes are taken
// in time order; the plan's included minutes earn the monthly fee spread evenly
// over them, minutes beyond earn the overage rate. Any unused part of the fee
// isn't tied to a call, so the month's margin can be higher than the rows' sum.

export interface CallCost {
  id: string; sourceId: string; channel: string; provider: string | null; billable: boolean;
  startedAt: number; durationSeconds: number; billableMinutes: number; llmModel: string | null;
  costPaise: number; phonePaise: number; speechPaise: number; aiPaise: number;
  revenuePaise: number; marginPaise: number;
}

export async function callCosts(env: Env, businessType: string, period: string): Promise<{ rows: CallCost[]; unallocatedFeePaise: number }> {
  const rates = costRates(env.BILLING_COST_RATES);
  const records = await usageRecordsFor(env, businessType, period, 1000);
  const account = await getAccount(env, businessType);
  const plan = account?.planId ? await getPlan(env, account.planId) : null;
  const feePerMinute = plan && plan.includedMinutes > 0 ? plan.monthlyFeePaise / plan.includedMinutes : 0;
  let minutesSoFar = 0;
  const revenue = new Map<string, number>();
  for (const r of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    if (!plan || !r.billable || r.channel !== 'voice') continue;
    let paise = 0;
    for (let m = 0; m < r.billableMinutes; m++, minutesSoFar++) {
      paise += minutesSoFar < plan.includedMinutes ? feePerMinute : plan.overagePaisePerMinute;
    }
    revenue.set(r.id, Math.round(paise));
  }
  const rows = records.map(r => {
    const parts = costParts({
      channel: r.channel as 'voice' | 'whatsapp', provider: r.provider, durationSeconds: r.durationSeconds,
      sttSeconds: r.sttSeconds, ttsChars: r.ttsChars, llmModel: r.llmModel,
      llm: { input: r.llmInputTokens, output: r.llmOutputTokens, cacheRead: r.llmCacheReadTokens, cacheWrite: r.llmCacheWriteTokens },
    }, rates);
    const costPaise = usdMicrosToPaise(r.costUsdMicros, rates);
    const phonePaise = usdMicrosToPaise(parts.telephony, rates);
    const aiPaise = usdMicrosToPaise(parts.llm, rates);
    const revenuePaise = revenue.get(r.id) ?? 0;
    return {
      id: r.id, sourceId: r.sourceId, channel: r.channel, provider: r.provider, billable: r.billable,
      startedAt: r.startedAt, durationSeconds: r.durationSeconds, billableMinutes: r.billableMinutes, llmModel: r.llmModel,
      costPaise, phonePaise, aiPaise, speechPaise: Math.max(0, costPaise - phonePaise - aiPaise),
      revenuePaise, marginPaise: revenuePaise - costPaise,
    };
  });
  const includedRevenue = plan ? Math.min(minutesSoFar, plan.includedMinutes) * feePerMinute : 0;
  return { rows, unallocatedFeePaise: plan ? Math.max(0, Math.round(plan.monthlyFeePaise - includedRevenue)) : 0 };
}

// ── WhatsApp ────────────────────────────────────────────────────────────────
// A conversation is a 24-hour window per customer per business (Meta's own
// unit). Counted separately from call minutes; not billed by the plans today.
const WA_CONVERSATION_SECONDS = 86_400;

export async function recordWhatsAppTurn(env: Env, businessType: string, customerHash: string, model: string, llm: LlmUsage): Promise<void> {
  try {
    const kvKey = `wa_conv:${businessType}:${customerHash}`;
    let conversationId = await env.CACHE.get(kvKey);
    if (!conversationId) {
      conversationId = `wa:${crypto.randomUUID()}`;
      await env.CACHE.put(kvKey, conversationId, { expirationTtl: WA_CONVERSATION_SECONDS });
      await recordUsage(env, {
        businessType, channel: 'whatsapp', provider: 'meta', sourceId: conversationId, startedAt: nowSec(),
      });
    }
    await addLlmUsage(env, 'whatsapp', conversationId, model, llm);
  } catch (e: any) {
    console.error('[billing] recordWhatsAppTurn failed', e?.message || e);
  }
}

// ── All businesses (operator) ───────────────────────────────────────────────

/** Every business with its billing state and this month's minutes, for the operator's Plans & billing page. */
export async function allAccountsStatus(env: Env, period = billingPeriod(new Date())) {
  const db = getDb(env.DB);
  const [rows, accounts, plans, minutes] = await Promise.all([
    db.select({ key: sectors.key, name: sectors.name, countryCode: sectors.countryCode }).from(sectors),
    db.select().from(billingAccounts),
    listPlans(env),
    db.select({
      businessType: usageRecords.businessType,
      minutes: sql<number>`coalesce(sum(${usageRecords.billableMinutes}), 0)`,
      costUsdMicros: sql<number>`coalesce(sum(${usageRecords.costUsdMicros}), 0)`,
    }).from(usageRecords).where(eq(usageRecords.period, period)).groupBy(usageRecords.businessType),
  ]);
  const byKey = new Map(accounts.map(a => [a.businessType, a]));
  const planById = new Map(plans.map(p => [p.id, p]));
  const use = new Map(minutes.map(m => [m.businessType, m]));
  const rates = costRates(env.BILLING_COST_RATES);
  const grace = graceDays(env.BILLING_GRACE_DAYS);
  return rows.map(r => {
    const a = byKey.get(r.key) ?? null;
    const plan = a?.planId ? planById.get(a.planId) ?? null : null;
    const m = use.get(r.key);
    return {
      businessType: r.key, name: r.name, countryCode: r.countryCode,
      state: billingState(a), overageAllowed: entitlements(a, grace).overageAllowed,
      plan: plan && { id: plan.id, name: plan.name, includedMinutes: plan.includedMinutes },
      trialEndsAt: a?.trialEndsAt ?? null, subscriptionStatus: a?.subscriptionStatus ?? null,
      cancelAtPeriodEnd: !!a?.cancelAtPeriodEnd, lastPaymentStatus: a?.lastPaymentStatus ?? null,
      minutes: Number(m?.minutes ?? 0), costPaise: usdMicrosToPaise(Number(m?.costUsdMicros ?? 0), rates),
    };
  });
}
