import type { Env } from '../types';

// Operator-chosen default business for inbound phone calls and the WhatsApp
// fallback, set from the admin UI. Lives in KV so it takes effect immediately,
// with no redeploy and without touching the Twilio webhook URL.
const KEY = 'config:default_business';

export async function getDefaultBusiness(env: Env): Promise<string | null> {
  try {
    return (await env.CACHE.get(KEY)) || null;
  } catch {
    // KV hiccup must never take a live call down; fall back to the env default.
    return null;
  }
}

export async function setDefaultBusiness(env: Env, businessType: string | null): Promise<void> {
  if (businessType) await env.CACHE.put(KEY, businessType);
  else await env.CACHE.delete(KEY);
}
