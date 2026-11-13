import type { Env } from '../types';
import { GRAPH_API_VERSION } from './whatsapp-api';
import { CARTESIA_VERSION } from '../durable-objects/tts-cartesia';

// ── Integrations registry ────────────────────────────────────────────────────
//
// Every outside service Avery needs, in one list: what it's for, which
// settings it reads, where to get them, and a cheap read-only live check
// that uses the configured key. Read by GET /admin/integrations (operator
// UI), POST /admin/integrations/:id/check, GET /account/features (owner
// "not available yet" notes) and scripts/preflight.mjs.
//
// Rules for checks: read-only, free, no messages sent, no calls placed, no
// money charged. Values never leave this file: callers get booleans per
// setting name, and errors are redacted against every configured secret.

export type Requirement = 'required' | 'carrier' | 'optional';
export type Status = 'not_configured' | 'unchecked' | 'ok' | 'fail';

export interface Setting {
  name: string;
  /** Needed for the service to count as set up. */
  required?: boolean;
  /** A plain var (wrangler.toml [vars]) rather than a `wrangler secret`. */
  plain?: boolean;
  /** Only used by the live check (e.g. the account id to look up). */
  checkOnly?: boolean;
  purpose: string;
}

export interface CheckResult {
  ok: boolean | null;          // null = skipped (not enough settings to check)
  latencyMs: number;
  error?: string;              // short and redacted
  note?: string;
  checkedAt: string;
}

export interface Integration {
  id: string;
  name: string;
  requirement: Requirement;
  unlocks: string;
  settings: Setting[];
  getFrom: string;             // where to get the keys
  doc: string;                 // repo doc for setup
  cost: string;
  /** Configured when every required setting is present (or bindings exist). */
  isConfigured?: (env: Env) => boolean;
  check: (env: Env) => Promise<Omit<CheckResult, 'latencyMs' | 'checkedAt'>>;
}

type E = Record<string, unknown>;
const v = (env: Env, name: string): string => {
  const x = (env as unknown as E)[name];
  return typeof x === 'string' ? x : '';
};
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;
const CHECK_TIMEOUT_MS = 8_000;

/** GET/POST and turn the HTTP answer into ok/fail with a short reason. */
async function probe(url: string, init: RequestInit, accept: (res: Response, body: string) => boolean = r => r.ok) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  const body = await res.text().catch(() => '');
  if (accept(res, body)) return { ok: true as const };
  return { ok: false as const, error: `HTTP ${res.status}${reasonFrom(body)}` };
}

function reasonFrom(body: string): string {
  try {
    const j = JSON.parse(body) as any;
    const m = j?.error?.message ?? j?.error?.description ?? j?.err_msg ?? j?.message ?? j?.error_description
      ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.err_code ?? j?.name;
    return m ? `: ${String(m)}` : '';
  } catch {
    return '';
  }
}

const skip = (note: string) => ({ ok: null, note });

export const INTEGRATIONS: Integration[] = [
  {
    id: 'cloudflare', name: 'Cloudflare D1 and KV', requirement: 'required',
    unlocks: 'The database and cache everything else runs on.',
    settings: [
      { name: 'DB', required: true, plain: true, purpose: 'D1 binding (wrangler.toml)' },
      { name: 'CACHE', required: true, plain: true, purpose: 'KV binding (wrangler.toml)' },
    ],
    getFrom: 'https://dash.cloudflare.com/', doc: 'README.md#deploy', cost: 'Workers paid plan, ~$5/month base',
    isConfigured: env => !!env.DB && !!env.CACHE,
    async check(env) {
      await env.DB.prepare('SELECT 1').first();
      await env.CACHE.get('health:probe');
      return { ok: true };
    },
  },
  {
    id: 'core', name: 'Avery secrets', requirement: 'required',
    unlocks: 'Sign-in tokens, caller privacy hashing and the operator key.',
    settings: [
      { name: 'TOKEN_SECRET', required: true, purpose: 'Signs sign-in and call tokens (32+ characters)' },
      { name: 'CUSTOMER_HASH_SALT', required: true, purpose: 'Hashes caller phone numbers' },
      { name: 'ADMIN_SECRET', required: true, purpose: 'The operator admin key' },
      { name: 'MOGI_SECRET', purpose: 'Shared secret for the storefront widget' },
    ],
    getFrom: 'Generate: openssl rand -hex 32', doc: 'README.md#deploy', cost: 'Free',
    async check(env) {
      if (v(env, 'TOKEN_SECRET').length < 32) return { ok: false, error: 'TOKEN_SECRET is shorter than 32 characters' };
      return { ok: true };
    },
  },
  {
    id: 'anthropic', name: 'Anthropic', requirement: 'required',
    unlocks: 'The AI that answers calls and WhatsApp messages.',
    settings: [
      { name: 'ANTHROPIC_API_KEY', required: true, purpose: 'API key' },
      { name: 'ANTHROPIC_MODEL', plain: true, purpose: 'Optional model override for chat' },
      { name: 'VOICE_MODEL', plain: true, purpose: 'Optional model override for calls' },
    ],
    getFrom: 'https://console.anthropic.com/settings/keys', doc: 'docs/production-readiness.md', cost: 'Per token; roughly ₹0.3–1 per call',
    check: env => probe('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    }),
  },
  {
    id: 'deepgram', name: 'Deepgram', requirement: 'required',
    unlocks: 'Speech recognition on English phone calls.',
    settings: [{ name: 'DEEPGRAM_API_KEY', required: true, purpose: 'API key' }],
    getFrom: 'https://console.deepgram.com/', doc: 'docs/production-readiness.md', cost: 'Per audio minute',
    check: env => probe('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${v(env, 'DEEPGRAM_API_KEY')}` } }),
  },
  {
    id: 'cartesia', name: 'Cartesia', requirement: 'required',
    unlocks: 'The assistant\'s voice on English calls.',
    settings: [
      { name: 'CARTESIA_API_KEY', required: true, purpose: 'API key' },
      { name: 'CARTESIA_VOICE_ID', plain: true, purpose: 'Optional default voice' },
      { name: 'CARTESIA_MODEL_ID', plain: true, purpose: 'Optional model' },
    ],
    getFrom: 'https://play.cartesia.ai/keys', doc: 'docs/production-readiness.md', cost: 'Per character spoken',
    check: env => probe('https://api.cartesia.ai/voices?limit=1', {
      headers: { 'X-API-Key': v(env, 'CARTESIA_API_KEY'), 'Cartesia-Version': CARTESIA_VERSION },
    }),
  },
  {
    id: 'sarvam', name: 'Sarvam', requirement: 'optional',
    unlocks: 'Hindi and Hinglish calls (speech recognition and voice).',
    settings: [{ name: 'SARVAM_API_KEY', required: true, purpose: 'API subscription key' }],
    getFrom: 'https://dashboard.sarvam.ai/', doc: 'docs/production-readiness.md', cost: 'Per audio minute and per character',
    // No free read endpoint: send an empty request. A valid key gets a
    // validation error (400/422) and nothing is synthesised or charged; a bad
    // key gets 401/403.
    check: env => probe('https://api.sarvam.ai/text-to-speech', {
      method: 'POST', headers: { 'api-subscription-key': v(env, 'SARVAM_API_KEY'), 'Content-Type': 'application/json' }, body: '{}',
    }, r => r.ok || r.status === 400 || r.status === 422),
  },
  {
    id: 'twilio', name: 'Twilio', requirement: 'carrier',
    unlocks: 'US phone numbers, and booking confirmation texts.',
    settings: [
      { name: 'TWILIO_AUTH_TOKEN', required: true, purpose: 'Verifies Twilio webhooks' },
      { name: 'TWILIO_WEBHOOK_URL', required: true, purpose: 'Public base URL Twilio calls' },
      { name: 'TWILIO_ACCOUNT_SID', purpose: 'Account (for texts and the live check)' },
      { name: 'TWILIO_SMS_FROM', purpose: 'Number that sends confirmation texts' },
    ],
    getFrom: 'https://console.twilio.com/', doc: 'README.md#twilio', cost: 'Per number per month, per minute, per text',
    async check(env) {
      const sid = v(env, 'TWILIO_ACCOUNT_SID');
      if (!sid) return skip('Add TWILIO_ACCOUNT_SID to check the key');
      return probe(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
        headers: { Authorization: basic(sid, v(env, 'TWILIO_AUTH_TOKEN')) },
      });
    },
  },
  {
    id: 'exotel', name: 'Exotel', requirement: 'carrier',
    unlocks: 'Indian phone numbers (ExoPhones).',
    settings: [
      { name: 'EXOTEL_WEBHOOK_SECRET', required: true, purpose: 'Carried by every Exotel webhook URL' },
      { name: 'EXOTEL_ACCOUNT_SID', checkOnly: true, purpose: 'Account SID (live check only)' },
      { name: 'EXOTEL_API_KEY', checkOnly: true, purpose: 'API key (live check only)' },
      { name: 'EXOTEL_API_TOKEN', checkOnly: true, purpose: 'API token (live check only)' },
      { name: 'EXOTEL_SUBDOMAIN', plain: true, checkOnly: true, purpose: 'api.exotel.com or api.in.exotel.com' },
    ],
    getFrom: 'https://my.exotel.com/apisettings/site#api-credentials', doc: 'README.md#exotel', cost: 'Per number per month and per minute',
    async check(env) {
      const sid = v(env, 'EXOTEL_ACCOUNT_SID'), key = v(env, 'EXOTEL_API_KEY'), token = v(env, 'EXOTEL_API_TOKEN');
      if (!sid || !key || !token) return skip('Add EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY and EXOTEL_API_TOKEN to check the account');
      const host = v(env, 'EXOTEL_SUBDOMAIN') || 'api.exotel.com';
      if (!/^[a-z0-9.-]+\.exotel\.com$/.test(host)) return { ok: false, error: 'EXOTEL_SUBDOMAIN must be an exotel.com host' };
      return probe(`https://${host}/v1/Accounts/${encodeURIComponent(sid)}/Calls.json?PageSize=1`, {
        headers: { Authorization: basic(key, token) },
      });
    },
  },
  {
    id: 'plivo', name: 'Plivo', requirement: 'carrier',
    unlocks: 'Indian phone numbers.',
    settings: [
      { name: 'PLIVO_AUTH_TOKEN', required: true, purpose: 'Verifies Plivo webhooks' },
      { name: 'PLIVO_WEBHOOK_URL', required: true, purpose: 'Public base URL Plivo calls' },
      { name: 'PLIVO_AUTH_ID', checkOnly: true, purpose: 'Auth ID (live check only)' },
    ],
    getFrom: 'https://console.plivo.com/dashboard/', doc: 'README.md#plivo', cost: 'Per number per month and per minute',
    async check(env) {
      const id = v(env, 'PLIVO_AUTH_ID');
      if (!id) return skip('Add PLIVO_AUTH_ID to check the account');
      return probe(`https://api.plivo.com/v1/Account/${encodeURIComponent(id)}/`, {
        headers: { Authorization: basic(id, v(env, 'PLIVO_AUTH_TOKEN')) },
      });
    },
  },
  {
    id: 'resend', name: 'Resend', requirement: 'required',
    unlocks: 'Email: sign-in codes, booking and billing notifications.',
    settings: [
      { name: 'RESEND_API_KEY', required: true, purpose: 'API key' },
      { name: 'EMAIL_FROM', required: true, plain: true, purpose: 'Sender, e.g. Avery <hello@yourdomain>' },
      { name: 'ADMIN_NOTIFY_EMAIL', plain: true, purpose: 'Where number requests are emailed' },
    ],
    getFrom: 'https://resend.com/api-keys', doc: 'docs/production-readiness.md', cost: 'Free up to 3,000 emails/month',
    // A sending-only key may not list domains: Resend answers 401
    // restricted_api_key, which still proves the key is real.
    check: env => probe('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${v(env, 'RESEND_API_KEY')}` } },
      (r, body) => r.ok || (r.status === 401 && body.includes('restricted_api_key'))),
  },
  {
    id: 'razorpay', name: 'Razorpay', requirement: 'optional',
    unlocks: 'Billing: subscriptions, payments and GST invoices.',
    settings: [
      { name: 'RAZORPAY_KEY_ID', required: true, purpose: 'API key id' },
      { name: 'RAZORPAY_KEY_SECRET', required: true, purpose: 'API key secret' },
      { name: 'RAZORPAY_WEBHOOK_SECRET', required: true, purpose: 'Webhook signing secret' },
      { name: 'BILLING_SUPPLIER_GSTIN', plain: true, purpose: 'Your GSTIN, printed on invoices' },
      { name: 'BILLING_SUPPLIER_NAME', plain: true, purpose: 'Legal name on invoices' },
      { name: 'BILLING_SUPPLIER_ADDRESS', plain: true, purpose: 'Address on invoices' },
      { name: 'BILLING_SAC_CODE', plain: true, purpose: 'SAC code on invoices' },
    ],
    getFrom: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys', doc: 'docs/razorpay-setup.md', cost: '~2% per payment',
    check: env => probe('https://api.razorpay.com/v1/plans?count=1', {
      headers: { Authorization: basic(v(env, 'RAZORPAY_KEY_ID'), v(env, 'RAZORPAY_KEY_SECRET')) },
    }),
  },
  {
    id: 'whatsapp', name: 'Meta WhatsApp', requirement: 'optional',
    unlocks: 'The assistant on WhatsApp.',
    settings: [
      { name: 'WA_APP_SECRET', required: true, purpose: 'Verifies messages come from Meta' },
      { name: 'WA_VERIFY_TOKEN', required: true, purpose: 'Webhook handshake token' },
      { name: 'WA_ACCESS_TOKEN', required: true, purpose: 'System-user token that sends replies' },
      { name: 'WA_PHONE_NUMBER_ID', purpose: 'Default number (also used by the live check)' },
      { name: 'WA_PHONE_NUMBER_MAP', purpose: 'Legacy number → business map' },
      { name: 'WA_CONFIRMATION_TEMPLATE', plain: true, purpose: 'Approved template for confirmations' },
      { name: 'WA_TEMPLATE_LANGUAGE', plain: true, purpose: 'Template language code' },
      { name: 'WA_GRAPH_API_VERSION', plain: true, purpose: 'Graph API version override' },
    ],
    getFrom: 'https://business.facebook.com/wa/manage/', doc: 'docs/whatsapp-setup.md', cost: 'Per conversation (Meta pricing)',
    async check(env) {
      const version = v(env, 'WA_GRAPH_API_VERSION') || GRAPH_API_VERSION;
      let id = v(env, 'WA_PHONE_NUMBER_ID');
      if (!id) {
        const row = await env.DB.prepare('SELECT phone_number_id AS id FROM whatsapp_numbers LIMIT 1').first<{ id: string }>().catch(() => null);
        id = row?.id ?? '';
      }
      const path = id ? `${encodeURIComponent(id)}?fields=display_phone_number,verified_name` : 'me';
      return probe(`https://graph.facebook.com/${version}/${path}`, { headers: { Authorization: `Bearer ${v(env, 'WA_ACCESS_TOKEN')}` } });
    },
  },
  {
    id: 'google', name: 'Google Calendar', requirement: 'optional',
    unlocks: 'Bookings go straight into the business\'s Google Calendar.',
    settings: [
      { name: 'GOOGLE_CLIENT_ID', required: true, purpose: 'OAuth client id' },
      { name: 'GOOGLE_CLIENT_SECRET', required: true, purpose: 'OAuth client secret' },
      { name: 'CALENDAR_TOKEN_KEY', required: true, purpose: 'Encrypts stored calendar tokens' },
    ],
    getFrom: 'https://console.cloud.google.com/apis/credentials', doc: 'README.md#google-calendar', cost: 'Free',
    // Exchange a deliberately invalid refresh token: Google answers
    // invalid_grant when the client id and secret are right, invalid_client
    // when they're not. Nothing is created.
    async check(env) {
      if (!v(env, 'GOOGLE_CLIENT_ID').endsWith('.apps.googleusercontent.com')) {
        return { ok: false, error: 'GOOGLE_CLIENT_ID should end with .apps.googleusercontent.com' };
      }
      return probe('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: 'avery-config-check',
          client_id: v(env, 'GOOGLE_CLIENT_ID'), client_secret: v(env, 'GOOGLE_CLIENT_SECRET'),
        }).toString(),
      }, (_r, body) => body.includes('invalid_grant'));
    },
  },
];

export const getIntegration = (id: string) => INTEGRATIONS.find(i => i.id === id);

/** Booleans per setting name. Values never leave this function. */
export function configuredMap(env: Env, i: Integration): Record<string, boolean> {
  return Object.fromEntries(i.settings.map(s => [s.name, !!(env as unknown as E)[s.name]]));
}

export function isConfigured(env: Env, i: Integration): boolean {
  if (i.isConfigured) return i.isConfigured(env);
  const map = configuredMap(env, i);
  return i.settings.filter(s => s.required).every(s => map[s.name]);
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Every configured setting value long enough to be a secret. */
function secretValues(env: Env): string[] {
  const out = new Set<string>();
  for (const i of INTEGRATIONS) for (const s of i.settings) {
    const x = v(env, s.name);
    if (x.length >= 6) out.add(x);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(env: Env, text: string): string {
  let t = text;
  for (const s of secretValues(env)) {
    t = t.split(s).join('[redacted]');
  }
  // And anything shaped like an auth header, whatever it carries.
  t = t.replace(/(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  return t.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// ── Running checks, with a KV cache ─────────────────────────────────────────

const RESULT_KEY = (id: string) => `integrations:check:${id}`;
export const RESULT_TTL_SECONDS = 15 * 60;
export const COOLDOWN_MS = 10_000;

export async function lastResult(env: Env, id: string): Promise<CheckResult | null> {
  const raw = await env.CACHE.get(RESULT_KEY(id)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as CheckResult; } catch { return null; }
}

export async function runCheck(env: Env, i: Integration): Promise<CheckResult> {
  const started = Date.now();
  let r: Omit<CheckResult, 'latencyMs' | 'checkedAt'>;
  if (!isConfigured(env, i)) {
    r = { ok: null, note: 'Not set up' };
  } else {
    try {
      r = await i.check(env);
    } catch (e: any) {
      r = { ok: false, error: e?.name === 'TimeoutError' ? 'Timed out' : String(e?.message || e) };
    }
  }
  const result: CheckResult = {
    ok: r.ok, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(),
    ...(r.error ? { error: redact(env, r.error) } : {}),
    ...(r.note ? { note: redact(env, r.note) } : {}),
  };
  if (result.ok === false) console.warn(JSON.stringify({ level: 'warn', msg: 'integration check failed', id: i.id, error: result.error }));
  await env.CACHE.put(RESULT_KEY(i.id), JSON.stringify(result), { expirationTtl: RESULT_TTL_SECONDS }).catch(() => undefined);
  return result;
}

export function statusOf(configured: boolean, last: CheckResult | null): Status {
  if (!configured) return 'not_configured';
  if (!last || last.ok === null) return 'unchecked';
  return last.ok ? 'ok' : 'fail';
}

export interface IntegrationView {
  id: string; name: string; requirement: Requirement; unlocks: string; getFrom: string; doc: string; cost: string;
  settings: (Omit<Setting, never> & { set: boolean })[];
  configured: Record<string, boolean>;
  missing: string[];
  status: Status;
  lastCheck: CheckResult | null;
}

export async function describeAll(env: Env): Promise<{ integrations: IntegrationView[]; readiness: Readiness }> {
  const integrations = await Promise.all(INTEGRATIONS.map(async (i): Promise<IntegrationView> => {
    const configured = configuredMap(env, i);
    const ok = isConfigured(env, i);
    const last = ok ? await lastResult(env, i.id) : null;
    return {
      id: i.id, name: i.name, requirement: i.requirement, unlocks: i.unlocks, getFrom: i.getFrom, doc: i.doc, cost: i.cost,
      settings: i.settings.map(s => ({ ...s, set: configured[s.name] })),
      configured,
      missing: i.settings.filter(s => s.required && !configured[s.name]).map(s => s.name),
      status: statusOf(ok, last),
      lastCheck: last,
    };
  }));
  return { integrations, readiness: readiness(integrations) };
}

// ── Production readiness ─────────────────────────────────────────────────────

export interface Blocker { id: string; name: string; status: Status; reason: string }
export interface Readiness { score: number; ready: boolean; blockers: Blocker[] }

const REASON: Record<Status, string> = {
  not_configured: 'Not set up', unchecked: 'Set up, not checked yet', fail: 'Failing its live check', ok: 'Working',
};

/**
 * Blockers first: every required service, plus at least one phone carrier.
 * Score: share of blockers that are Working (a set-up-but-unchecked one
 * counts half).
 */
export function readiness(views: Pick<IntegrationView, 'id' | 'name' | 'requirement' | 'status'>[]): Readiness {
  const groups: { id: string; name: string; status: Status }[] = views
    .filter(x => x.requirement === 'required')
    .map(x => ({ id: x.id, name: x.name, status: x.status }));
  const carriers = views.filter(x => x.requirement === 'carrier');
  const rank: Record<Status, number> = { ok: 3, unchecked: 2, fail: 1, not_configured: 0 };
  const bestCarrier = carriers.sort((a, b) => rank[b.status] - rank[a.status])[0];
  groups.push({ id: 'carrier', name: 'A phone carrier (Twilio, Exotel or Plivo)', status: bestCarrier?.status ?? 'not_configured' });
  const points = groups.reduce((n, g) => n + (g.status === 'ok' ? 1 : g.status === 'unchecked' ? 0.5 : 0), 0);
  const blockers = groups.filter(g => g.status !== 'ok').map(g => ({ ...g, reason: REASON[g.status] }));
  return { score: Math.round((points / groups.length) * 100), ready: blockers.length === 0, blockers };
}

/** What owners may use: services set up on this deployment (booleans only). */
export function features(env: Env) {
  const on = (id: string) => isConfigured(env, getIntegration(id)!);
  return { hindi: on('sarvam'), calendar: on('google'), whatsapp: on('whatsapp'), billing: on('razorpay'), sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_SMS_FROM && env.TWILIO_AUTH_TOKEN), email: on('resend') };
}
