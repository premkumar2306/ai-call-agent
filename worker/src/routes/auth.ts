import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { HonoEnv } from '../middleware';
import type { SessionPayload } from '../types';
import { getSectors } from '../services/sector.service';

const authRouter = new Hono<HonoEnv>();

// Mock customer accounts — replace with real DB lookup in prod
const CUSTOMERS: Record<string, { tier: 'BASIC' | 'SILVER' | 'GOLD' | 'PLATINUM'; store_credit_cents: number }> = {
  'customer-001': { tier: 'GOLD',     store_credit_cents: 5000  },
  'customer-002': { tier: 'SILVER',   store_credit_cents: 2000  },
  'customer-003': { tier: 'PLATINUM', store_credit_cents: 15000 },
};

async function hashId(id: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// POST /auth/token
// Body: { customer_id, sector }  — sector must be a known key in sectors table
authRouter.post('/token', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const devId = c.env.NODE_ENV !== 'production'
    ? c.req.header('x-dev-customer-id')
    : undefined;

  const customerId: string = devId ?? body?.customer_id;
  const sector: string = body?.sector ?? 'auto_shop';

  if (!customerId) {
    return c.json({ success: false, error: 'customer_id required' }, 400);
  }
  const sectors = await getSectors(c.env);
  if (!sectors[sector]) {
    return c.json({ success: false, error: `Unknown sector. Valid: ${Object.keys(sectors).join(', ')}` }, 400);
  }

  const account = CUSTOMERS[customerId] ?? { tier: 'BASIC' as const, store_credit_cents: 0 };
  const ttl = parseInt(c.env.TOKEN_TTL_SECONDS ?? '900', 10);
  const now = Math.floor(Date.now() / 1000);
  const sub = await hashId(customerId, c.env.CUSTOMER_HASH_SALT ?? 'dev-hash-salt');

  const payload: SessionPayload = { sub, businessType: sector, iat: now, exp: now + ttl, account };

  const secret = new TextEncoder().encode(c.env.TOKEN_SECRET);
  const token = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);

  return c.json({ success: true, data: { token, expires_in: ttl, sector, account } });
});

export { authRouter };
