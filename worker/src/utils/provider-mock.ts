import type { Env } from '../types';

// End-to-end test hook (worker/e2e/): send every call to an outside service
// (Anthropic, Deepgram, Cartesia, Sarvam, Razorpay, Resend, Twilio REST,
// WhatsApp, and the integration checks' Plivo, Exotel and Google OAuth) to a
// local stand-in instead, so a whole phone call can run on one machine with no accounts or keys:
//
//   https://api.sarvam.ai/text-to-speech/stream  →  $PROVIDER_MOCK_URL/api.sarvam.ai/text-to-speech/stream
//
// Only when PROVIDER_MOCK_URL is set AND NODE_ENV is not "production"; a
// production Worker never redirects, whatever its vars say.

export const MOCKED_HOSTS = new Set([
  'api.anthropic.com',
  'api.deepgram.com',
  'api.cartesia.ai',
  'api.sarvam.ai',
  'api.razorpay.com',
  'api.resend.com',
  'api.twilio.com',
  'graph.facebook.com',
  'api.plivo.com',
  'api.exotel.com',
  'api.in.exotel.com',
  'oauth2.googleapis.com',
]);

/** The URL to fetch instead of `url`, or null to leave it alone. */
export function mockedUrl(url: string, base: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!MOCKED_HOSTS.has(u.hostname)) return null;
  return `${base.replace(/\/$/, '')}/${u.hostname}${u.pathname}${u.search}`;
}

const ORIGINAL = Symbol.for('avery.originalFetch');

export function installProviderMock(env: Pick<Env, 'NODE_ENV' | 'PROVIDER_MOCK_URL'>): void {
  const base = env.PROVIDER_MOCK_URL;
  if (!base || env.NODE_ENV === 'production') return;
  const g = globalThis as typeof globalThis & { [ORIGINAL]?: typeof fetch };
  if (g[ORIGINAL]) return;   // once per isolate
  const original = globalThis.fetch.bind(globalThis);
  g[ORIGINAL] = original;
  console.warn(`[provider-mock] outside services go to ${base}`);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = mockedUrl(url, base);
    if (!target) return original(input, init);
    return input instanceof Request ? original(new Request(target, input), init) : original(target, init);
  };
}
