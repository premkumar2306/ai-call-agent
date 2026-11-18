import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { withBusinessAccess } from '../middleware';
import { getSector, setGuardrails } from '../services/sector.service';
import { guardrailsEnabled } from '../services/guardrails';

// /admin/guardrails/:businessType — switch conversation guardrails on or off,
// and list what fired (for Operator → Calls). Off by default; docs/guardrails.md.
const owner = withBusinessAccess('owner');
export const guardrailsAdminRouter = new Hono<HonoEnv>();

guardrailsAdminRouter.get('/:businessType', owner, async (c) => {
  const bt = c.req.param('businessType') ?? '';
  const meta = await getSector(c.env, bt);
  if (!meta) return c.json({ success: false, error: 'Unknown business' }, 404);
  const callSid = c.req.query('callSid');
  const { results } = await (callSid
    ? c.env.DB.prepare('SELECT call_sid, kind, detail, created_at FROM guardrail_events WHERE business_type = ? AND call_sid = ? ORDER BY created_at DESC LIMIT 100').bind(bt, callSid)
    : c.env.DB.prepare('SELECT call_sid, kind, detail, created_at FROM guardrail_events WHERE business_type = ? ORDER BY created_at DESC LIMIT 100').bind(bt)
  ).all();
  return c.json({ success: true, data: { enabled: guardrailsEnabled(meta), events: results } });
});

guardrailsAdminRouter.put('/:businessType', owner, async (c) => {
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return c.json({ success: false, error: 'enabled must be true or false' }, 400);
  if (!(await setGuardrails(c.env, c.req.param('businessType') ?? '', body.enabled))) return c.json({ success: false, error: 'Unknown business' }, 404);
  return c.json({ success: true, data: { enabled: body.enabled } });
});
