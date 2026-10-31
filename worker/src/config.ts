import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './types';

// ── Runtime configuration shared by every route / Durable Object ─────────────

// Haiku is chosen for voice latency. Override per environment with the
// ANTHROPIC_MODEL var instead of editing call sites.
export const DEFAULT_AGENT_MODEL = 'claude-haiku-5-5';

// Hard ceiling on the agentic tool loop per turn — bounds latency and spend.
export const MAX_TOOL_ROUNDS = 5;

// Per-attempt model timeout on a live call (one retry on top).
export const VOICE_MODEL_TIMEOUT_MS = 6_000;

export function agentModel(env: Env): string {
  return env.ANTHROPIC_MODEL || DEFAULT_AGENT_MODEL;
}

// The live-call path runs a different model from the other agent surfaces.
// Haiku 5.5 over Haiku 4.5 for two reasons: its minimum cacheable prefix is
// 512 tokens rather than 4096, which is what makes the cache_control
// breakpoints in turn.service.ts actually do something (that prompt is ~1.8K
// tokens, so on Haiku 4.5 every breakpoint was silently inert); and it is
// ~10x cheaper per token.
//
// turn.service.ts pairs this with thinking disabled and effort pinned low:
// Haiku 5.5 runs adaptive thinking by default at medium effort, which for a
// two-sentence phone reply is latency paid for nothing.
//
// Deliberately separate from DEFAULT_AGENT_MODEL — the web chat, WhatsApp and
// end-of-call classifier have different prompt shapes and latency budgets,
// and moving them is a change worth making on its own evidence.
export const DEFAULT_VOICE_MODEL = 'claude-haiku-5-5';

export function voiceModel(env: Env): string {
  return env.VOICE_MODEL || DEFAULT_VOICE_MODEL;
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
