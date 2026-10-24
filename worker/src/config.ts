import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './types';

// ── Runtime configuration shared by every route / Durable Object ─────────────

// Haiku is chosen for voice latency. Override per environment with the
// ANTHROPIC_MODEL var instead of editing call sites.
export const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5-20251001';

// Hard ceiling on the agentic tool loop per turn — bounds latency and spend.
export const MAX_TOOL_ROUNDS = 5;

export function agentModel(env: Env): string {
  return env.ANTHROPIC_MODEL || DEFAULT_AGENT_MODEL;
}

// The SDK default timeout is 10 minutes, which is never acceptable on a live
// call or webhook. Fail fast and let the caller fall back to a canned reply.
export function createAnthropic(env: Env, opts: { timeoutMs?: number; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: opts.timeoutMs ?? 20_000,
    maxRetries: opts.maxRetries ?? 1,
  });
}

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

// Config the Worker genuinely cannot serve traffic without in production.
// Each of these fails *closed* somewhere — a missing one doesn't degrade a
// feature, it takes a path down completely — and every one of them does so
// deep inside a request, where the only symptom is a generic error to the
// caller. Surfaced through /health?deep=1 so the post-deploy smoke test
// catches it instead of the first person to dial the number.
//
// Returns variable names only, never values.
export function missingProductionConfig(env: Env): string[] {
  if (!isProduction(env)) return [];
  const missing: string[] = [];

  // Signs session tokens and the Twilio media-stream token; tokenSecretKey()
  // throws below 32 chars, which 500s /twilio/inbound.
  if (!env.TOKEN_SECRET || env.TOKEN_SECRET.length < 32) missing.push('TOKEN_SECRET');
  if (!env.CUSTOMER_HASH_SALT) missing.push('CUSTOMER_HASH_SALT');
  if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');

  // Twilio webhook signature verification fails closed without both, so every
  // inbound call is rejected. TWILIO_WEBHOOK_URL must be the exact public base
  // URL Twilio dials — the signature is computed over that URL string.
  if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!env.TWILIO_WEBHOOK_URL) missing.push('TWILIO_WEBHOOK_URL');

  // Voice is the product; a call connects and then sits silent without these.
  if (!env.DEEPGRAM_API_KEY) missing.push('DEEPGRAM_API_KEY');
  if (!env.CARTESIA_API_KEY) missing.push('CARTESIA_API_KEY');

  return missing;
}

// HMAC salt for customer identifiers. A missing salt in production would hash
// every customer with a public constant, so refuse instead of degrading.
export function customerHashSalt(env: Env): string {
  if (env.CUSTOMER_HASH_SALT) return env.CUSTOMER_HASH_SALT;
  if (isProduction(env)) throw new Error('CUSTOMER_HASH_SALT is not configured');
  return 'dev-hash-salt';
}

export function tokenSecretKey(env: Env): Uint8Array {
  const secret = env.TOKEN_SECRET;
  if (!secret || (isProduction(env) && secret.length < 32)) {
    throw new Error('TOKEN_SECRET is missing or shorter than 32 characters');
  }
  return new TextEncoder().encode(secret);
}

// Constant-time string comparison for shared secrets and signatures.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Default timeout for outbound REST calls to third parties (Deepgram REST,
// Meta Graph, Resend). Streaming calls manage their own lifetimes.
export const HTTP_TIMEOUT_MS = 15_000;
