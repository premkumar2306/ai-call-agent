import { and, eq, isNotNull, ne, or, isNull, sql, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { billingAccounts, billingInvoices, billingPlans, razorpayEvents, usageRecords } from '../../db/schema';
import type { Env } from '../../types';
import { getSector } from '../sector.service';
import { sendEmail } from '../notify.service';
import {
  billableMinutes, billingPeriod, computeOverage, costRates, estimateCostUsdMicros, formatInr,
  gstinStateCode, previousPeriod, splitGst, usageAlertLevel, usdMicrosToPaise, withGst, gstOn,
  type LlmUsage,
} from './pricing';
import * as razorpay from './razorpay';

export type Plan = typeof billingPlans.$inferSelect;
export type Account = typeof billingAccounts.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Billing state ───────────────────────────────────────────────────────────

export type BillingState =
  | 'off'        // no plan: nothing is billed (the default for every business)
  | 'trialing'   // inside the free trial
  | 'active'     // Razorpay subscription authenticated/active
  | 'past_due'   // Razorpay could not charge (pending/halted)
  | 'cancelled'  // subscription cancelled/completed/expired
  | 'unpaid';    // trial over and no subscription yet

/** Pure: what the owner sees as their billing status. Never blocks calls. */
export function billingState(account: Pick<Account, 'planId' | 'trialEndsAt' | 'subscriptionStatus'> | null | undefined, now = nowSec()): BillingState {
  if (!account?.planId) return 'off';
  switch (account.subscriptionStatus) {
    case 'authenticated': case 'active': case 'resumed': return 'active';
    case 'pending': case 'halted': return 'past_due';
    case 'cancelled': case 'completed': case 'expired': return 'cancelled';
  }
  if (account.trialEndsAt && account.trialEndsAt > now) return 'trialing';
  return 'unpaid';
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
  overagePaisePerMinute: number; trialDays?: number; gstRateBps?: number; isActive?: boolean;
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
    updatedAt: now,
  };
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
    await db.update(billingAccounts).set({
      planId,
      ...(existing.trialEndsAt == null && !existing.razorpaySubscriptionId && planId ? { trialEndsAt } : {}),
      updatedAt: now,
    }).where(eq(billingAccounts.businessType, businessType));
  } else {
    await db.insert(billingAccounts).values({ businessType, planId, trialEndsAt, createdAt: now, updatedAt: now });
  }
  return (await getAccount(env, businessType))!;
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

  const summary: Record<string, unknown> = {
    businessType,
    state: billingState(account),
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
      alertLevel: plan ? usageAlertLevel(usage.minutes, plan.includedMinutes) : 0,
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

export async function startSubscription(env: Env, businessType: string): Promise<{ subscriptionId: string; keyId: string; shortUrl?: string }> {
  const account = await getAccount(env, businessType);
  if (!account?.planId) throw Object.assign(new Error('Billing is not enabled for this business'), { status: 409 });
  const plan = await getPlan(env, account.planId);
  if (!plan?.razorpayPlanId) throw Object.assign(new Error('Plan is not set up in Razorpay yet'), { status: 409 });
  if (!razorpay.razorpayConfigured(env)) throw new razorpay.RazorpayNotConfigured();

  // Re-use a subscription that hasn't been paid for yet (the owner closed Checkout).
  if (account.razorpaySubscriptionId && (account.subscriptionStatus === 'created' || !account.subscriptionStatus)) {
    return { subscriptionId: account.razorpaySubscriptionId, keyId: env.RAZORPAY_KEY_ID! };
  }
  if (billingState(account) === 'active') throw Object.assign(new Error('Already subscribed'), { status: 409 });

  const now = nowSec();
  // First charge after the trial; Razorpay needs start_at comfortably in the future.
  const startAt = account.trialEndsAt && account.trialEndsAt > now + 3600 ? account.trialEndsAt : undefined;
  const sub = await razorpay.createSubscription(env, {
    planId: plan.razorpayPlanId, totalCount: SUBSCRIPTION_CYCLES, startAt,
    notes: { business_type: businessType, avery_plan_id: plan.id },
  });
  await getDb(env.DB).update(billingAccounts).set({
    razorpaySubscriptionId: sub.id, subscriptionStatus: sub.status, updatedAt: now,
  }).where(eq(billingAccounts.businessType, businessType));
  return { subscriptionId: sub.id, keyId: env.RAZORPAY_KEY_ID!, shortUrl: sub.short_url };
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
    await getDb(env.DB).update(billingAccounts).set({ subscriptionStatus: 'authenticated', updatedAt: nowSec() })
      .where(eq(billingAccounts.businessType, businessType));
  }
  return true;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

export interface RazorpayWebhook {
  event: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: { id?: string; status?: string; current_end?: number | null; customer_id?: string | null; notes?: Record<string, string> } };
    payment?: { entity?: { id?: string; amount?: number; status?: string } };
  };
}

/**
 * Returns what happened, for the log line. Idempotent on the event id, which
 * is recorded only after the event is applied (a failure → 5xx → Razorpay
 * retries). Webhooks can arrive out of order, so when the API keys are set
 * the subscription's current state is re-read from Razorpay rather than
 * trusting the (possibly stale) payload.
 */
export async function applyWebhook(env: Env, eventId: string | null, evt: RazorpayWebhook): Promise<string> {
  const db = getDb(env.DB);
  if (eventId) {
    const [seen] = await db.select().from(razorpayEvents).where(eq(razorpayEvents.id, eventId));
    if (seen) return 'duplicate';
  }
  const result = await applySubscriptionEvent(env, evt);
  if (eventId) await db.insert(razorpayEvents).values({ id: eventId, event: evt.event, receivedAt: nowSec() }).onConflictDoNothing();
  return result;
}

async function applySubscriptionEvent(env: Env, evt: RazorpayWebhook): Promise<string> {
  if (!evt.event?.startsWith('subscription.')) return 'ignored';
  const payloadSub = evt.payload?.subscription?.entity;
  if (!payloadSub?.id) return 'no subscription in payload';

  const db = getDb(env.DB);
  const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.razorpaySubscriptionId, payloadSub.id));
  if (!account) return `unknown subscription ${payloadSub.id}`;

  let sub: { status?: string; current_end?: number | null; customer_id?: string | null } = payloadSub;
  if (razorpay.razorpayConfigured(env)) {
    try { sub = await razorpay.fetchSubscription(env, payloadSub.id); }
    catch (e: any) { console.error('[billing] could not re-read subscription; using payload', e?.message || e); }
  }
  await db.update(billingAccounts).set({
    ...(sub.status ? { subscriptionStatus: sub.status } : {}),
    ...(sub.current_end ? { currentPeriodEnd: sub.current_end } : {}),
    ...(sub.customer_id ? { razorpayCustomerId: sub.customer_id } : {}),
    updatedAt: nowSec(),
  }).where(eq(billingAccounts.businessType, account.businessType));
  return `${account.businessType}: ${evt.event} → ${sub.status ?? 'unchanged'}`;
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
  const [py, pm] = period.split('-').map(Number);
  const periodEnd = Math.floor(Date.UTC(pm === 12 ? py + 1 : py, pm === 12 ? 0 : pm, 1) / 1000) - 19_800; // IST midnight

  for (const account of accounts) {
    const [existing] = await db.select().from(billingInvoices)
      .where(and(eq(billingInvoices.businessType, account.businessType), eq(billingInvoices.period, period)));
    if (existing && existing.status !== 'failed') continue;

    const plan = await getPlan(env, account.planId!);
    if (!plan) continue;
    const usage = await periodUsage(env, account.businessType, period);
    const o = computeOverage(plan, usage.minutes);

    let status: string;
    let addonId: string | null = null;
    let error: string | null = null;
    if (o.overagePaise === 0) status = 'no_overage';
    else if (account.trialEndsAt && account.trialEndsAt >= periodEnd) status = 'trial'; // trial covered the whole month
    else if (!account.razorpaySubscriptionId || billingState(account) !== 'active') status = 'unbilled';
    else {
      try {
        const addon = await razorpay.createAddon(env, account.razorpaySubscriptionId, {
          name: `Extra minutes ${period}`,
          description: `${o.overageMinutes} min over ${plan.includedMinutes} @ ${formatInr(plan.overagePaisePerMinute)} + ${plan.gstRateBps / 100}% GST`,
          amountPaise: o.totalPaise, currency: plan.currency,
        });
        addonId = addon.id;
        status = 'billed';
      } catch (e: any) {
        status = 'failed';
        error = String(e?.message || e).slice(0, 500);
      }
    }

    const now = nowSec();
    const row = {
      planId: plan.id, minutesUsed: o.minutesUsed, includedMinutes: o.includedMinutes, overageMinutes: o.overageMinutes,
      overagePaise: o.overagePaise, gstPaise: o.gstPaise, totalPaise: o.totalPaise,
      status, razorpayAddonId: addonId, error, updatedAt: now,
    };
    if (existing) await db.update(billingInvoices).set(row).where(eq(billingInvoices.id, existing.id));
    else await db.insert(billingInvoices).values({ id: crypto.randomUUID(), businessType: account.businessType, period, ...row, createdAt: now });
    results.push({ businessType: account.businessType, status, ...(error ? { error } : {}) });
  }
  return results;
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
