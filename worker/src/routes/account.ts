import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { HonoEnv } from '../middleware';
import { hitLimit, ipRateLimit, withBusinessAccess, withOwner } from '../middleware';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { HTTP_TIMEOUT_MS, isProduction } from '../config';
import {
  BUSINESS_KINDS, LOGIN_CODE_TTL_SECONDS, OWNER_SESSION_TTL_SECONDS, ROLES, type Role,
  addMember, changeMember, consumeLoginCode, createBusiness, emailIdentifier, findOrCreateUser,
  identifierHash, issueLoginCode, listBusinessesFor, listMembers, normalizeEmail, parseBusinessInput,
  revokeSessions, signOwnerToken,
} from '../services/accounts';
import { getSector } from '../services/sector.service';
import { escapeHtml } from '../services/email.service';
import { isAllowedOrigin } from '../utils/origins';
import type { Env } from '../types';

// /account/* — sign-up / sign-in by emailed one-time code, the signed-in
// user's businesses, onboarding (create a business) and team management.

const accountRouter = new Hono<HonoEnv>();

const MAX_OWNED_BUSINESSES = 10;

async function sendAccountEmail(env: Env, to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM ?? 'Avery <avery@mogi.ai>', to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const emailConfigured = (env: Env) => !!env.RESEND_API_KEY && env.RESEND_API_KEY !== 'CHANGE_ME';

// POST /account/login/start { email } — emails a 6-digit code.
// The same response whether or not the address has an account: the account
// is created when the code is verified.
accountRouter.post('/login/start', ipRateLimit('login-start', 10, 900), async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ success: false, error: 'Enter a valid email address' }, 400);

  const prod = isProduction(c.env);
  if (prod && !emailConfigured(c.env)) {
    return c.json({ success: false, error: 'Email sign-in is not configured on this server' }, 503);
  }
  // Per-address cap, so nobody can flood an inbox or farm codes for one account.
  if (await hitLimit(c.env, `rl:login-email:${await identifierHash(c.env, email)}`, 5, 3600)) {
    return c.json({ success: false, error: 'Too many codes requested for this address. Try again in an hour.' }, 429);
  }

  const code = await issueLoginCode(c.env, emailIdentifier(email));
  const minutes = LOGIN_CODE_TTL_SECONDS / 60;
  if (emailConfigured(c.env)) {
    try {
      await sendAccountEmail(c.env, email, `${code} is your Avery sign-in code`,
        `Your Avery sign-in code is ${code}. It expires in ${minutes} minutes.\n\nIf you didn't ask for it, ignore this email.`,
        `<p>Your Avery sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
        `<p>It expires in ${minutes} minutes. If you didn't ask for it, ignore this email.</p>`);
    } catch (e: any) {
      console.error('[account] login email failed', e?.message || e);
      return c.json({ success: false, error: "We couldn't send the email. Try again shortly." }, 502);
    }
  }
  return c.json({
    success: true,
    data: {
      expiresInSeconds: LOGIN_CODE_TTL_SECONDS,
      // Local development without Resend: hand the code back so sign-in works.
      ...(!prod && !emailConfigured(c.env) ? { devCode: code } : {}),
    },
  });
});

// POST /account/login/verify { email, code } → { token, user, businesses }
accountRouter.post('/login/verify', ipRateLimit('login-verify', 30, 900), async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const ok = email ? await consumeLoginCode(c.env, emailIdentifier(email), body?.code) : false;
  // One message for every failure: wrong, expired, used up, or never sent.
  if (!ok || !email) return c.json({ success: false, error: 'That code is wrong or has expired' }, 401);

  const user = await findOrCreateUser(c.env, email);
  await getDb(c.env.DB).update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return c.json({
    success: true,
    data: {
      token: await signOwnerToken(c.env, user),
      expiresInSeconds: OWNER_SESSION_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
      businesses: await listBusinessesFor(c.env, user.id),
    },
  });
});

// GET /account/me — the signed-in user and the businesses they belong to
accountRouter.get('/me', withOwner, async (c) => {
  const p = c.get('principal');
  if (p.kind !== 'user') return c.json({ success: false, error: 'Sign in required' }, 401);
  return c.json({
    success: true,
    data: {
      user: { id: p.user.id, email: p.user.email, name: p.user.name },
      businesses: await listBusinessesFor(c.env, p.user.id),
      businessKinds: BUSINESS_KINDS,
    },
  });
});

// PUT /account/me { name }
accountRouter.put('/me', withOwner, async (c) => {
  const p = c.get('principal');
  if (p.kind !== 'user') return c.json({ success: false, error: 'Sign in required' }, 401);
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  await getDb(c.env.DB).update(users).set({ name: name || null }).where(eq(users.id, p.user.id));
  return c.json({ success: true });
});

// POST /account/logout — signs this user out everywhere
accountRouter.post('/logout', withOwner, async (c) => {
  const p = c.get('principal');
  if (p.kind === 'user') await revokeSessions(c.env, p.user.id);
  return c.json({ success: true });
});

// GET /account/business-kinds — options for the onboarding wizard (public)
accountRouter.get('/business-kinds', (c) => c.json({ success: true, data: BUSINESS_KINDS }));

// POST /account/businesses — onboarding wizard: create a business you own
accountRouter.post('/businesses', withOwner, async (c) => {
  const p = c.get('principal');
  if (p.kind !== 'user') return c.json({ success: false, error: 'Sign in required' }, 401);
  if (await hitLimit(c.env, `rl:create-business:${p.user.id}`, 5, 86400)) {
    return c.json({ success: false, error: 'Too many businesses created today. Try again tomorrow.' }, 429);
  }
  const owned = (await listBusinessesFor(c.env, p.user.id)).filter(b => b.role === 'owner');
  if (owned.length >= MAX_OWNED_BUSINESSES) {
    return c.json({ success: false, error: `You can own up to ${MAX_OWNED_BUSINESSES} businesses. Contact support for more.` }, 403);
  }
  const input = parseBusinessInput(await c.req.json().catch(() => null));
  if (typeof input === 'string') return c.json({ success: false, error: input }, 400);
  const key = await createBusiness(c.env, p.user, input);
  return c.json({ success: true, data: { key, name: input.name } }, 201);
});

// ── Team ───────────────────────────────────────────────────────────────────

// GET /account/businesses/:businessType/members
accountRouter.get('/businesses/:businessType/members', withBusinessAccess('owner'), async (c) => {
  const rows = await listMembers(c.env, c.req.param('businessType') ?? '');
  return c.json({ success: true, data: rows.map(r => ({ ...r, addedAt: (r.addedAt as Date).toISOString() })) });
});

const parseRole = (r: unknown): Role | null => (ROLES as readonly string[]).includes(r as string) ? r as Role : null;

// POST /account/businesses/:businessType/members { email, role } — add (or change) a member.
// The person signs in with that address to get access; no separate invite step.
accountRouter.post('/businesses/:businessType/members', withBusinessAccess('owner'),
  ipRateLimit('add-member', 30, 3600), async (c) => {
    const businessKey = c.req.param('businessType') ?? '';
    const meta = await getSector(c.env, businessKey);
    if (!meta) return c.json({ success: false, error: 'Business not found' }, 404);
    const body = await c.req.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const role = parseRole(body?.role ?? 'staff');
    if (!email) return c.json({ success: false, error: 'Enter a valid email address' }, 400);
    if (!role) return c.json({ success: false, error: 'role must be owner or staff' }, 400);
    if ((await listMembers(c.env, businessKey)).length >= 50) {
      return c.json({ success: false, error: 'A business can have up to 50 team members' }, 403);
    }
    const user = await addMember(c.env, businessKey, email, role);

    if (emailConfigured(c.env)) {
      const origin = c.req.header('origin');
      const link = origin && isAllowedOrigin(origin, c.env) ? origin : null;
      const name = meta.name;
      c.executionCtx.waitUntil(sendAccountEmail(c.env, email, `You've been added to ${name} on Avery`,
        `You now have ${role} access to ${name}'s Avery dashboard.` +
        (link ? ` Sign in at ${link} with this email address.` : ' Sign in with this email address.'),
        `<p>You now have ${role} access to <b>${escapeHtml(name)}</b>'s Avery dashboard.</p>` +
        (link ? `<p><a href="${escapeHtml(link)}">Sign in</a> with this email address.</p>` : '<p>Sign in with this email address.</p>'),
      ).catch(e => console.error('[account] invite email failed', e?.message || e)));
    }
    return c.json({ success: true, data: { userId: user.id, email: user.email, role } });
  });

// PATCH /account/businesses/:businessType/members/:userId { role }
accountRouter.patch('/businesses/:businessType/members/:userId', withBusinessAccess('owner'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const role = parseRole(body?.role);
  if (!role) return c.json({ success: false, error: 'role must be owner or staff' }, 400);
  return memberResult(c, await changeMember(c.env, c.req.param('businessType') ?? '', c.req.param('userId') ?? '', role));
});

// DELETE /account/businesses/:businessType/members/:userId
accountRouter.delete('/businesses/:businessType/members/:userId', withBusinessAccess('owner'), async (c) => {
  return memberResult(c, await changeMember(c.env, c.req.param('businessType') ?? '', c.req.param('userId') ?? '', null));
});

function memberResult(c: any, r: 'ok' | 'not_found' | 'last_owner') {
  if (r === 'not_found') return c.json({ success: false, error: 'Not a member of this business' }, 404);
  if (r === 'last_owner') return c.json({ success: false, error: 'A business needs at least one owner' }, 409);
  return c.json({ success: true });
}

export { accountRouter };
