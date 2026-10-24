import { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import type { Env, SessionPayload } from './types';
import { timingSafeEqual, tokenSecretKey } from './config';

export type HonoEnv = {
  Bindings: Env;
  Variables: { session: SessionPayload };
};

// Bearer token → session
export async function withSession(c: Context<HonoEnv>, next: Next) {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Bearer token required' }, 401);
  }
  let session: SessionPayload;
  try {
    session = await verifySessionToken(c.env, auth.slice(7));
  } catch {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }
  c.set('session', session);
  // next() is outside the try so downstream errors reach the global error
  // handler instead of being misreported as an auth failure.
  await next();
}

export async function verifySessionToken(env: Env, token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, tokenSecretKey(env), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || typeof payload.businessType !== 'string') {
    throw new Error('Malformed session token');
  }
  return payload as unknown as SessionPayload;
}

// Builds the fallback anonymous-caller session used when a Twilio webhook has
// no ?token=. Shared with CallRelay (the media-stream Durable Object), which
// has no per-message token/signature to verify.
export function buildDefaultTwilioSession(env: Env, businessType?: string): SessionPayload | null {
  const resolvedBusinessType =
    businessType ??
    env.TWILIO_DEFAULT_BUSINESS_TYPE ??
    env.TWILIO_DEFAULT_SECTOR;
  const sub = env.TWILIO_DEFAULT_CUSTOMER_HASH;
  if (!resolvedBusinessType || !sub) return null;

  const now = Math.floor(Date.now() / 1000);
  return {
    sub,
    businessType: resolvedBusinessType,
    iat: now,
    exp: now + 3600, // 1-hour window per call, renewed each inbound
    account: { store_credit_cents: 0, tier: 'BASIC' },
  };
}

// Twilio webhooks — token from ?token=<jwt> OR falls back to default caller session.
// The fallback lets you use a static webhook URL (no expiring token in the URL).
// Set TWILIO_DEFAULT_BUSINESS_TYPE and TWILIO_DEFAULT_CUSTOMER_HASH in wrangler.toml/secrets.
export async function withTwilioSession(c: Context<HonoEnv>, next: Next) {
  const token = c.req.query('token');

  if (token) {
    let session: SessionPayload;
    try {
      session = await verifySessionToken(c.env, token);
    } catch {
      return c.text('<?xml version="1.0"?><Response><Say>Session expired. Please call back.</Say></Response>', 200, {
        'Content-Type': 'text/xml',
      });
    }
    c.set('session', session);
    return await next();
  }

  // No token — ?businessType= query param overrides the env var default
  const session = buildDefaultTwilioSession(c.env, c.req.query('businessType'));
  if (session) {
    c.set('session', session);
    return await next();
  }

  return c.text('<?xml version="1.0"?><Response><Say>This line is not configured. Goodbye.</Say></Response>', 200, {
    'Content-Type': 'text/xml',
  });
}

// Service-to-service auth — keep off the browser
// Fails closed: an unset MOGI_SECRET rejects every request rather than
// matching a missing header (undefined === undefined).
export async function withMogiSecret(c: Context<HonoEnv>, next: Next) {
  const provided = c.req.header('x-mogi-secret');
  if (!c.env.MOGI_SECRET || !provided || !timingSafeEqual(provided, c.env.MOGI_SECRET)) {
    return c.json({ success: false, error: 'Invalid Mogi secret' }, 401);
  }
  await next();
}

// Operator admin auth — protects all mutating /admin/* routes
export async function withAdminKey(c: Context<HonoEnv>, next: Next) {
  const key = c.req.header('x-admin-key');
  if (!c.env.ADMIN_SECRET || !key || !timingSafeEqual(key, c.env.ADMIN_SECRET)) {
    return c.json({ success: false, error: 'Admin key required' }, 401);
  }
  await next();
}

// ── Rate limiting (KV fixed-window counter) ────────────────────────────────
//
// ipRateLimit     — identify by CF-Connecting-IP; use before auth is established
// sessionRateLimit— identify by JWT sub; apply after withSession

// KV has no atomic increment, so concurrent requests can slightly overshoot
// `max`. That's acceptable: the goal is capping third-party spend, not exact
// quotas.
async function hitLimit(env: Env, kvKey: string, max: number, windowSeconds: number): Promise<boolean> {
  const raw = await env.CACHE.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= max) return true;
  await env.CACHE.put(kvKey, String(count + 1), { expirationTtl: Math.max(60, windowSeconds) });
  return false;
}

const tooMany = (c: Context<HonoEnv>) =>
  c.json({ success: false, error: 'Too many requests. Please wait before retrying.' }, 429);

export function ipRateLimit(scope: string, max: number, windowSeconds: number) {
  return async function (c: Context<HonoEnv>, next: Next) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    if (await hitLimit(c.env, `rl:${scope}:${ip}`, max, windowSeconds)) return tooMany(c);
    await next();
  };
}

export function sessionRateLimit(scope: string, max: number, windowSeconds: number) {
  return async function (c: Context<HonoEnv>, next: Next) {
    const session = c.get('session');
    if (!session) { await next(); return; }
    if (await hitLimit(c.env, `rl:${scope}:${session.sub}`, max, windowSeconds)) return tooMany(c);
    await next();
  };
}
