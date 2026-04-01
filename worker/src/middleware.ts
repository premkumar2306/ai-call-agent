import { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import type { Env, SessionPayload } from './types';

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
  try {
    const key = new TextEncoder().encode(c.env.TOKEN_SECRET);
    const { payload } = await jwtVerify(auth.slice(7), key);
    c.set('session', payload as unknown as SessionPayload);
    await next();
  } catch {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }
}

// Twilio webhooks — token from ?token=<jwt> OR falls back to default caller session.
// The fallback lets you use a static webhook URL (no expiring token in the URL).
// Set TWILIO_DEFAULT_BUSINESS_TYPE and TWILIO_DEFAULT_CUSTOMER_HASH in wrangler.toml/secrets.
export async function withTwilioSession(c: Context<HonoEnv>, next: Next) {
  const token = c.req.query('token');

  if (token) {
    try {
      const key = new TextEncoder().encode(c.env.TOKEN_SECRET);
      const { payload } = await jwtVerify(token, key);
      c.set('session', payload as unknown as SessionPayload);
      return await next();
    } catch {
      return c.text('<?xml version="1.0"?><Response><Say>Session expired. Please call back.</Say></Response>', 200, {
        'Content-Type': 'text/xml',
      });
    }
  }

  // No token — use default caller session if configured
  // Support both new TWILIO_DEFAULT_BUSINESS_TYPE and legacy TWILIO_DEFAULT_SECTOR
  const businessType = c.env.TWILIO_DEFAULT_BUSINESS_TYPE ?? c.env.TWILIO_DEFAULT_SECTOR;
  const sub          = c.env.TWILIO_DEFAULT_CUSTOMER_HASH;
  if (businessType && sub) {
    const now = Math.floor(Date.now() / 1000);
    const session: SessionPayload = {
      sub,
      businessType,
      iat: now,
      exp: now + 3600, // 1-hour window per call, renewed each inbound
      account: { store_credit_cents: 0, tier: 'BASIC' },
    };
    c.set('session', session);
    return await next();
  }

  return c.text('<?xml version="1.0"?><Response><Say>This line is not configured. Goodbye.</Say></Response>', 200, {
    'Content-Type': 'text/xml',
  });
}

// Service-to-service auth — keep off the browser
export async function withAverySecret(c: Context<HonoEnv>, next: Next) {
  if (c.req.header('x-avery-secret') !== c.env.AVERY_SECRET) {
    return c.json({ success: false, error: 'Invalid Avery secret' }, 401);
  }
  await next();
}

// Operator admin auth — protects all mutating /admin/* routes
export async function withAdminKey(c: Context<HonoEnv>, next: Next) {
  const key = c.req.header('x-admin-key');
  if (!key || key !== c.env.ADMIN_SECRET) {
    return c.json({ success: false, error: 'Admin key required' }, 401);
  }
  await next();
}
