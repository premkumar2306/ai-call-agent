import { HTTP_TIMEOUT_MS, isProduction, timingSafeEqual } from '../../config';
import type { Env } from '../../types';

// Razorpay REST client (https://api.razorpay.com/v1, HTTP Basic with
// RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET) and the two signature checks:
//
//   webhook  — X-Razorpay-Signature = hex(HMAC-SHA256(RAZORPAY_WEBHOOK_SECRET, raw body))
//   checkout — razorpay_signature   = hex(HMAC-SHA256(RAZORPAY_KEY_SECRET,
//                                       razorpay_payment_id + '|' + razorpay_subscription_id))
//
// The webhook secret is the one entered in Dashboard → Webhooks, not the API
// key secret. Both checks need the exact bytes Razorpay signed, so the raw
// body is verified before it is parsed.

const API = 'https://api.razorpay.com/v1';

export class RazorpayNotConfigured extends Error {
  constructor() { super('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)'); }
}

export function razorpayConfigured(env: Env): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyRazorpaySignature(message: string, signature: string | null | undefined, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  return timingSafeEqual(await hmacSha256Hex(secret, message), signature.trim().toLowerCase());
}

export type WebhookCheck = 'ok' | 'bad_signature' | 'not_configured';

/**
 * Fails closed in production: with no RAZORPAY_WEBHOOK_SECRET every webhook
 * is rejected. Outside production an unset secret lets unsigned test
 * payloads through (curl), matching the Twilio/WhatsApp webhooks.
 */
export async function checkWebhook(env: Env, rawBody: string, signature: string | null | undefined): Promise<WebhookCheck> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return isProduction(env) ? 'not_configured' : 'ok';
  return (await verifyRazorpaySignature(rawBody, signature, secret)) ? 'ok' : 'bad_signature';
}

export function verifyCheckoutSignature(env: Env, paymentId: string, subscriptionId: string, signature: string): Promise<boolean> {
  if (!env.RAZORPAY_KEY_SECRET) return Promise.resolve(false);
  return verifyRazorpaySignature(`${paymentId}|${subscriptionId}`, signature, env.RAZORPAY_KEY_SECRET);
}

async function call<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!razorpayConfigured(env)) throw new RazorpayNotConfigured();
  const res = await fetch(`${API}${path}`, {
    method,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.error?.description ?? detail; } catch { /* not JSON */ }
    throw new Error(`Razorpay ${method} ${path} → ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}

export interface RazorpayPlan { id: string }
export interface RazorpaySubscription {
  id: string; status: string; short_url?: string; plan_id: string;
  current_start?: number | null; current_end?: number | null; customer_id?: string | null;
}
export interface RazorpayAddon { id: string }

/** POST /plans — `amountPaise` is what the customer pays each month (incl. GST). */
export function createPlan(env: Env, p: { name: string; amountPaise: number; currency: string; description?: string; notes?: Record<string, string> }) {
  return call<RazorpayPlan>(env, 'POST', '/plans', {
    period: 'monthly', interval: 1,
    item: { name: p.name, amount: p.amountPaise, currency: p.currency, description: p.description },
    notes: p.notes,
  });
}

/**
 * POST /subscriptions. `startAt` (unix seconds, future) defers the first
 * charge to the end of a free trial; the customer still authorises the
 * mandate (UPI AutoPay / card) at checkout. `totalCount` is the number of
 * billing cycles before the subscription completes.
 */
export function createSubscription(env: Env, s: { planId: string; totalCount: number; startAt?: number; notes?: Record<string, string> }) {
  return call<RazorpaySubscription>(env, 'POST', '/subscriptions', {
    plan_id: s.planId,
    total_count: s.totalCount,
    quantity: 1,
    customer_notify: 1,
    ...(s.startAt ? { start_at: s.startAt } : {}),
    notes: s.notes,
  });
}

export function fetchSubscription(env: Env, id: string) {
  return call<RazorpaySubscription>(env, 'GET', `/subscriptions/${encodeURIComponent(id)}`);
}

/** POST /subscriptions/:id/addons — added to the subscription's next invoice. */
export function createAddon(env: Env, subscriptionId: string, a: { name: string; description: string; amountPaise: number; currency: string }) {
  return call<RazorpayAddon>(env, 'POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/addons`, {
    item: { name: a.name, description: a.description, amount: a.amountPaise, currency: a.currency },
    quantity: 1,
  });
}
