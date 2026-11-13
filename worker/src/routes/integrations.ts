import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { hitLimit, isAdmin, ownerFromRequest, withAdminKey } from '../middleware';
import { COOLDOWN_MS, describeAll, features, getIntegration, lastResult, runCheck } from '../services/integrations';

// Operator: GET /admin/integrations, POST /admin/integrations/:id/check.
// Booleans per setting name and redacted check results only; no value ever
// leaves the Worker.
export const integrationsAdminRouter = new Hono<HonoEnv>();

integrationsAdminRouter.get('/', withAdminKey, async (c) => {
  return c.json({ success: true, data: await describeAll(c.env) });
});

integrationsAdminRouter.post('/:id/check', withAdminKey, async (c) => {
  const i = getIntegration(c.req.param('id') ?? '');
  if (!i) return c.json({ success: false, error: 'Unknown integration' }, 404);
  // One check per service every 10 s, and 40 checks a minute in all: each
  // check is an outside API call made with the production key.
  const last = await lastResult(c.env, i.id);
  const age = last ? Date.now() - Date.parse(last.checkedAt) : Infinity;
  if (age < COOLDOWN_MS) {
    return c.json({ success: false, error: `Checked moments ago; try again in ${Math.ceil((COOLDOWN_MS - age) / 1000)}s`, data: last }, 429);
  }
  if (await hitLimit(c.env, 'rl:integrations:check', 40, 60)) {
    return c.json({ success: false, error: 'Too many checks. Please wait a minute.' }, 429);
  }
  return c.json({ success: true, data: await runCheck(c.env, i) });
});

// Signed-in owners and the operator: which optional features this deployment
// has set up, so Settings can say "not available yet" instead of failing.
export const featuresRouter = new Hono<HonoEnv>();

featuresRouter.get('/', async (c) => {
  const admin = isAdmin(c);
  if (admin === false) return c.json({ success: false, error: 'Admin key required' }, 401);
  if (!admin && !(await ownerFromRequest(c))) return c.json({ success: false, error: 'Sign in required' }, 401);
  return c.json({ success: true, data: features(c.env) });
});
