import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { HonoEnv } from '../middleware';
import { ipRateLimit } from '../middleware';
import type { SessionPayload } from '../types';
import { getSectors } from '../services/sector.service';
import { hashId, getOrCreateCustomer } from '../utils/identity';

const authRouter = new Hono<HonoEnv>();

// POST /auth/token  — 10 requests / 60 s per IP to prevent brute-force token generation
// Body: { customer_id, sector | businessType } — value must be a known key in sectors table
authRouter.post('/token', ipRateLimit('auth', 10, 60), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const devId = c.env.NODE_ENV !== 'production'
    ? c.req.header('x-dev-customer-id')
    : undefined;

  const customerId: string = devId ?? body?.customer_id;
  const requestedBusinessType = typeof body?.businessType === 'string'
    ? body.businessType.trim()
    : '';
  const requestedSector = typeof body?.sector === 'string'
    ? body.sector.trim()
    : '';
  const sector = requestedBusinessType || requestedSector || 'auto_shop';

  if (!customerId) {
    return c.json({ success: false, error: 'customer_id required' }, 400);
  }
  const sectors = await getSectors(c.env);
  if (!sectors[sector]) {
    return c.json({ success: false, error: `Unknown sector. Valid: ${Object.keys(sectors).join(', ')}` }, 400);
  }

  const ttl = parseInt(c.env.TOKEN_TTL_SECONDS ?? '900', 10);
  const now = Math.floor(Date.now() / 1000);
  const sub = await hashId(customerId, c.env.CUSTOMER_HASH_SALT ?? 'dev-hash-salt');

  const account = await getOrCreateCustomer(c.env, sub);

  const payload: SessionPayload = { sub, businessType: sector, iat: now, exp: now + ttl, account };

  const secret = new TextEncoder().encode(c.env.TOKEN_SECRET);
  const token = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);

  return c.json({ success: true, data: { token, expires_in: ttl, sector, businessType: sector, account } });
});

export { authRouter };
