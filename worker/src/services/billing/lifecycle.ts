import { and, eq, isNotNull, ne, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { billingAccounts, billingPlans, razorpayEvents } from '../../db/schema';
import type { Env } from '../../types';
import { getSector } from '../sector.service';
import { sendEmail } from '../notify.service';
import { graceDays } from './pricing';
import * as razorpay from './razorpay';
import { issueTaxInvoice, recordRefund } from './invoices';
import { billingState, entitlements, getAccount, getPlan, type Account, type Plan } from './service';

// The subscription lifecycle after Checkout: Razorpay webhooks, dunning
// (failed-payment emails, grace period, restriction), and the owner's own
// actions (change plan, cancel, update payment). Calls are never refused or
// cut off by anything here; a restricted account only stops being charged
// overage (see entitlements()).

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

// ── Webhook ─────────────────────────────────────────────────────────────────

type Entity = Record<string, any>;
export interface RazorpayWebhook {
  event: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: Entity };
    payment?: { entity?: Entity };
    invoice?: { entity?: Entity };
    refund?: { entity?: Entity };
  };
}

/**
 * Applies a verified webhook once per event id (X-Razorpay-Event-Id). The id
 * is claimed first, so two concurrent deliveries can't both apply; if
 * applying fails the claim is released and the 5xx makes Razorpay retry.
 */
export async function applyWebhook(env: Env, eventId: string | null, evt: RazorpayWebhook): Promise<string> {
  const db = getDb(env.DB);
  if (eventId) {
    const r = await db.insert(razorpayEvents).values({ id: eventId, event: evt.event, receivedAt: nowSec() }).onConflictDoNothing().run();
    if (!((r as any).meta?.changes > 0)) return 'duplicate';
  }
  try {
    return await dispatch(env, evt);
  } catch (e) {
    if (eventId) await db.delete(razorpayEvents).where(eq(razorpayEvents.id, eventId)).catch(() => {});
    throw e;
  }
}

async function dispatch(env: Env, evt: RazorpayWebhook): Promise<string> {
  if (evt.event.startsWith('subscription.')) return onSubscription(env, evt);
  if (evt.event === 'payment.captured' || evt.event === 'payment.failed') return onPayment(env, evt);
  if (evt.event === 'invoice.paid') return onInvoicePaid(env, evt);
  if (evt.event === 'refund.processed') {
    const r = evt.payload?.refund?.entity, p = evt.payload?.payment?.entity;
    if (!r?.payment_id) return 'no refund in payload';
    const total = typeof p?.amount_refunded === 'number' ? p.amount_refunded : Number(r.amount ?? 0);
    return (await recordRefund(env, r.payment_id, total)) ? `refund ${r.payment_id}` : 'refund for unknown payment';
  }
  return 'ignored';
}

async function accountBySubscription(env: Env, subscriptionId: string | null | undefined): Promise<Account | null> {
  if (!subscriptionId) return null;
  const [row] = await getDb(env.DB).select().from(billingAccounts).where(eq(billingAccounts.razorpaySubscriptionId, subscriptionId));
  return row ?? null;
}

async function planByRazorpayId(env: Env, razorpayPlanId: string | null | undefined): Promise<Plan | null> {
  if (!razorpayPlanId) return null;
  const [row] = await getDb(env.DB).select().from(billingPlans).where(eq(billingPlans.razorpayPlanId, razorpayPlanId));
  return row ?? null;
}

const CLEARS_PAST_DUE = new Set(['subscription.activated', 'subscription.charged', 'subscription.resumed', 'subscription.authenticated']);

async function onSubscription(env: Env, evt: RazorpayWebhook): Promise<string> {
  const payloadSub = evt.payload?.subscription?.entity;
  if (!payloadSub?.id) return 'no subscription in payload';
  const account = await accountBySubscription(env, payloadSub.id);
  if (!account) return `unknown subscription ${payloadSub.id}`;

  // Webhooks can arrive out of order: re-read the current state from Razorpay.
  let sub: Entity = payloadSub;
  if (razorpay.razorpayConfigured(env)) {
    try { sub = await razorpay.fetchSubscription(env, payloadSub.id); }
    catch (e: any) { console.error('[billing] could not re-read subscription; using payload', e?.message || e); }
  }
  const status: string | undefined = sub.status;
  const plan = await planByRazorpayId(env, sub.plan_id);
  const update: Partial<Account> = {
    ...(status ? { subscriptionStatus: status } : {}),
    ...(sub.current_end ? { currentPeriodEnd: sub.current_end } : {}),
    ...(sub.customer_id ? { razorpayCustomerId: sub.customer_id } : {}),
    // A scheduled downgrade (or an upgrade) has taken effect.
    ...(plan && plan.id !== account.planId ? { planId: plan.id } : {}),
    ...(plan && account.pendingPlanId === plan.id ? { pendingPlanId: null } : {}),
    updatedAt: nowSec(),
  };
  if (status && ['cancelled', 'completed', 'expired'].includes(status)) Object.assign(update, { cancelAtPeriodEnd: false, pendingPlanId: null });
  if ((status === 'active' || status === 'authenticated') && CLEARS_PAST_DUE.has(evt.event)) {
    Object.assign(update, { pastDueSince: null, lastPaymentStatus: evt.event === 'subscription.charged' ? 'captured' : account.lastPaymentStatus, lastPaymentError: null });
  }
  await getDb(env.DB).update(billingAccounts).set(update).where(eq(billingAccounts.businessType, account.businessType));
  if (status === 'pending' || status === 'halted') {
    await markPastDue(env, account.businessType, status === 'halted' ? 'Razorpay stopped retrying the payment' : 'A monthly charge failed');
  }
  return `${account.businessType}: ${evt.event} → ${status ?? 'unchanged'}`;
}

/** Finds the business a payment belongs to: its invoice's subscription, the customer, or Checkout's notes. */
async function accountForPayment(env: Env, p: Entity): Promise<Account | null> {
  let account = await accountBySubscription(env, p.subscription_id);
  if (!account && p.invoice_id && razorpay.razorpayConfigured(env)) {
    try { account = await accountBySubscription(env, (await razorpay.fetchInvoice(env, p.invoice_id)).subscription_id); }
    catch (e: any) { console.error('[billing] could not read invoice for payment', e?.message || e); }
  }
  if (!account && p.customer_id) {
    const [row] = await getDb(env.DB).select().from(billingAccounts).where(eq(billingAccounts.razorpayCustomerId, p.customer_id));
    account = row ?? null;
  }
  if (!account && typeof p.notes?.business_type === 'string') account = await getAccount(env, p.notes.business_type);
  return account?.planId ? account : null;
}

async function onPayment(env: Env, evt: RazorpayWebhook): Promise<string> {
  const p = evt.payload?.payment?.entity;
  if (!p?.id) return 'no payment in payload';
  const account = await accountForPayment(env, p);
  if (!account) return `payment ${p.id} is not a subscription payment`;
  const at = Number(p.created_at ?? evt.created_at ?? nowSec());
  // An older payment's event arriving late never overrides a newer outcome.
  if (account.lastPaymentAt && at < account.lastPaymentAt) return `${account.businessType}: stale ${evt.event}`;
  const failed = evt.event === 'payment.failed';
  const error = failed ? String(p.error_description || p.error_reason || 'Payment failed').slice(0, 300) : null;
  await getDb(env.DB).update(billingAccounts).set({
    lastPaymentStatus: failed ? 'failed' : 'captured', lastPaymentAt: at, lastPaymentError: error,
    ...(failed ? {} : { pastDueSince: null }),
    updatedAt: nowSec(),
  }).where(eq(billingAccounts.businessType, account.businessType));
  // A card declined inside Checkout (no mandate yet) is shown there; dunning is
  // for a subscription that was paying and now isn't.
  if (failed && account.subscriptionStatus && !['created'].includes(account.subscriptionStatus)) {
    await markPastDue(env, account.businessType, error!);
  }
  return `${account.businessType}: ${evt.event}`;
}

async function onInvoicePaid(env: Env, evt: RazorpayWebhook): Promise<string> {
  const inv = evt.payload?.invoice?.entity;
  if (!inv?.id) return 'no invoice in payload';
  const account = await accountBySubscription(env, inv.subscription_id);
  if (!account) return `invoice ${inv.id} is not for a known subscription`;
  const plan = account.planId ? await getPlan(env, account.planId) : null;
  const paymentId = evt.payload?.payment?.entity?.id ?? inv.payment_id ?? null;
  const tax = await issueTaxInvoice(env, account, plan, inv as razorpay.RazorpayInvoice, paymentId);
  await getDb(env.DB).update(billingAccounts).set({
    pastDueSince: null, lastPaymentStatus: 'captured', lastPaymentError: null, updatedAt: nowSec(),
  }).where(eq(billingAccounts.businessType, account.businessType));
  return `${account.businessType}: tax invoice ${tax.invoiceNumber}`;
}

// ── Dunning ─────────────────────────────────────────────────────────────────

function billingLink(env: Env): string {
  return env.APP_URL ? `${env.APP_URL.replace(/\/$/, '')}/#settings/billing` : 'Avery → Settings → Billing';
}

const istDate = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

/** Sends a notice once per `key` (e.g. one per failed-payment episode); concurrent callers can't both send. */
async function claimNotice(env: Env, businessType: string, key: string): Promise<boolean> {
  const r = await getDb(env.DB).update(billingAccounts).set({ lastNotice: key })
    .where(and(eq(billingAccounts.businessType, businessType), or(isNull(billingAccounts.lastNotice), ne(billingAccounts.lastNotice, key)))).run();
  return (r as any).meta?.changes > 0;
}

async function contact(env: Env, account: Account): Promise<{ to: string | null; name: string }> {
  const sector = await getSector(env, account.businessType);
  return { to: account.billingEmail || sector?.notifyEmail || null, name: sector?.name ?? account.businessType };
}

/** Starts (or continues) a failed-payment episode and emails the owner once for it. */
export async function markPastDue(env: Env, businessType: string, reason: string): Promise<void> {
  const db = getDb(env.DB);
  const now = nowSec();
  await db.update(billingAccounts).set({ pastDueSince: now, updatedAt: now })
    .where(and(eq(billingAccounts.businessType, businessType), isNull(billingAccounts.pastDueSince)));
  const account = (await getAccount(env, businessType))!;
  if (!(await claimNotice(env, businessType, `failed:${account.pastDueSince}`))) return;
  const { to, name } = await contact(env, account);
  if (!to) return;
  const ent = entitlements(account, graceDays(env.BILLING_GRACE_DAYS), now);
  await sendEmail(env, to, `${name}: payment failed, please update your payment method`,
    `We couldn't collect your Avery subscription payment (${reason}).\n\n` +
    `Your AI receptionist keeps answering every call. Please update your payment method in ${billingLink(env)}` +
    (ent.graceEndsAt ? ` before ${istDate(ent.graceEndsAt)}. After that, minutes beyond your plan stop being available until payment goes through.` : '.') +
    `\n\nRazorpay also retries the charge automatically.\n`,
  ).catch(e => console.error('[billing] dunning email failed', e?.message || e));
}

/**
 * Daily (cron): the "grace period is over" notice, and a reminder 3 days
 * before a free trial ends without a subscription. Each is sent once.
 */
export async function runDunning(env: Env, now = nowSec()): Promise<string[]> {
  const sent: string[] = [];
  const grace = graceDays(env.BILLING_GRACE_DAYS);
  const accounts = await getDb(env.DB).select().from(billingAccounts).where(isNotNull(billingAccounts.planId));
  for (const account of accounts) {
    const state = billingState(account, now);
    const ent = entitlements(account, grace, now);
    let key: string | null = null, subject = '', body = '';
    const { name } = await contact(env, account);
    if (state === 'past_due' && ent.restricted) {
      key = `restricted:${account.pastDueSince}`;
      subject = `${name}: extra minutes paused until payment is updated`;
      body = `Your Avery payment is still overdue. Your AI receptionist keeps answering calls within your plan's minutes, ` +
        `but minutes beyond the plan are no longer available. Update your payment method in ${billingLink(env)} to restore them.\n`;
    } else if (state === 'trialing' && account.trialEndsAt && account.trialEndsAt - now <= 3 * DAY) {
      key = `trial:${account.trialEndsAt}`;
      subject = `${name}: your free trial ends on ${istDate(account.trialEndsAt)}`;
      body = `Your Avery free trial ends on ${istDate(account.trialEndsAt)}. Subscribe in ${billingLink(env)} ` +
        `(UPI AutoPay or card) to keep your plan. You won't be charged before the trial ends.\n`;
    }
    if (!key || !(await claimNotice(env, account.businessType, key))) continue;
    const { to } = await contact(env, account);
    if (!to) continue;
    await sendEmail(env, to, subject, body).then(() => sent.push(`${account.businessType}:${key}`))
      .catch(e => console.error('[billing] dunning email failed', e?.message || e));
  }
  return sent;
}

// ── Owner actions ───────────────────────────────────────────────────────────

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Plans an owner may pick (active ones), without Razorpay ids. */
export async function ownerPlans(env: Env) {
  const plans = await getDb(env.DB).select().from(billingPlans).where(eq(billingPlans.isActive, true)).orderBy(billingPlans.monthlyFeePaise);
  return plans.map(p => ({
    id: p.id, name: p.name, currency: p.currency, monthlyFeePaise: p.monthlyFeePaise, includedMinutes: p.includedMinutes,
    overagePaisePerMinute: p.overagePaisePerMinute, gstRateBps: p.gstRateBps, checkoutReady: !!p.razorpayPlanId,
  }));
}

/**
 * Upgrade (takes effect now; Razorpay charges the difference) or downgrade
 * (from the next cycle). Before there's a paying subscription the plan just
 * changes; during a trial with a mandate already set up, the mandate is for
 * the old amount, so it is cancelled and the owner subscribes again.
 */
export async function changePlan(env: Env, businessType: string, planId: string): Promise<{ effective: 'now' | 'cycle_end'; needsCheckout: boolean }> {
  const account = await getAccount(env, businessType);
  if (!account?.planId) throw httpError(409, 'Billing is not enabled for this business');
  const [current, next] = await Promise.all([getPlan(env, account.planId), getPlan(env, planId)]);
  if (!next || !next.isActive) throw httpError(404, 'Unknown plan');
  if (planId === account.planId && !account.pendingPlanId) throw httpError(409, `Already on ${next.name}`);
  const db = getDb(env.DB);
  const set = (v: Partial<Account>) => db.update(billingAccounts).set({ ...v, updatedAt: nowSec() }).where(eq(billingAccounts.businessType, businessType));
  const status = account.subscriptionStatus;

  if (status === 'active' && account.razorpaySubscriptionId) {
    if (planId === account.planId) { // undo a scheduled downgrade
      if (current?.razorpayPlanId) await razorpay.updateSubscriptionPlan(env, account.razorpaySubscriptionId, current.razorpayPlanId, 'now');
      await set({ pendingPlanId: null });
      return { effective: 'now', needsCheckout: false };
    }
    if (!next.razorpayPlanId) throw httpError(409, `${next.name} isn't set up in Razorpay yet`);
    const upgrade = next.monthlyFeePaise > (current?.monthlyFeePaise ?? 0);
    await razorpay.updateSubscriptionPlan(env, account.razorpaySubscriptionId, next.razorpayPlanId, upgrade ? 'now' : 'cycle_end');
    await set(upgrade ? { planId, pendingPlanId: null } : { pendingPlanId: planId });
    return { effective: upgrade ? 'now' : 'cycle_end', needsCheckout: false };
  }
  if (status === 'pending' || status === 'halted') throw httpError(409, 'Update your payment first, then change plan');
  if (status === 'authenticated' && account.razorpaySubscriptionId) {
    await razorpay.cancelSubscription(env, account.razorpaySubscriptionId, false);
    await set({ planId, pendingPlanId: null, razorpaySubscriptionId: null, subscriptionStatus: null, cancelAtPeriodEnd: false });
    return { effective: 'now', needsCheckout: true };
  }
  // Trial / unpaid / cancelled / an unfinished Checkout: just switch.
  await set({
    planId, pendingPlanId: null,
    ...(status === 'created' ? { razorpaySubscriptionId: null, subscriptionStatus: null } : {}),
  });
  return { effective: 'now', needsCheckout: status === 'cancelled' };
}

/**
 * Cancels at the end of the paid-for cycle (an active subscription keeps
 * working until then), or at once when nothing has been charged yet or
 * Razorpay has given up (halted).
 */
export async function cancelSubscription(env: Env, businessType: string): Promise<{ atPeriodEnd: boolean; status: string }> {
  const account = await getAccount(env, businessType);
  if (!account?.razorpaySubscriptionId || !account.subscriptionStatus || ['cancelled', 'completed', 'expired'].includes(account.subscriptionStatus)) {
    throw httpError(409, 'There is no subscription to cancel');
  }
  if (account.cancelAtPeriodEnd) throw httpError(409, 'Already cancelled at the end of this period');
  const atPeriodEnd = account.subscriptionStatus === 'active' || account.subscriptionStatus === 'pending';
  const sub = await razorpay.cancelSubscription(env, account.razorpaySubscriptionId, atPeriodEnd);
  const status = atPeriodEnd ? account.subscriptionStatus : (sub.status || 'cancelled');
  await getDb(env.DB).update(billingAccounts).set({
    subscriptionStatus: status, cancelAtPeriodEnd: atPeriodEnd, pendingPlanId: null, updatedAt: nowSec(),
  }).where(eq(billingAccounts.businessType, businessType));
  return { atPeriodEnd, status };
}

/**
 * "Update payment": Razorpay's hosted page for the subscription, where the
 * owner pays the due charge or authorises a new mandate. A halted
 * subscription is replaced through Subscribe instead.
 */
export async function updatePaymentLink(env: Env, businessType: string): Promise<{ url: string | null; resubscribe: boolean }> {
  const account = await getAccount(env, businessType);
  if (!account?.razorpaySubscriptionId) throw httpError(409, 'There is no subscription yet: subscribe first');
  if (account.subscriptionStatus === 'halted') return { url: null, resubscribe: true };
  const sub = await razorpay.fetchSubscription(env, account.razorpaySubscriptionId);
  return { url: sub.short_url ?? null, resubscribe: !sub.short_url };
}
