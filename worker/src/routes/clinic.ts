import { Hono } from 'hono';
import { withAdminKey, withBusinessAccess, type HonoEnv } from '../middleware';
import { isProduction } from '../config';
import { getClinicFeatures, markVisit, OFF, runClinicFollowUps, saveClinicFeatures, validateClinicFeatures } from '../services/clinic-features';

// /clinic/:businessType — clinic feature switches (owner) and visit outcomes
// (staff mark "completed" / "no show" on the Appointments page).
// /admin/clinic/run — the hourly follow-up job on demand (operator).

export const clinicRouter = new Hono<HonoEnv>();

clinicRouter.get('/:businessType', withBusinessAccess('staff'), async (c) => {
  const f = await getClinicFeatures(c.env, c.req.param('businessType')!);
  const { businessType: _b, createdAt: _c, updatedAt: _u, ...rest } = f ?? { businessType: '', createdAt: 0, updatedAt: 0, ...OFF };
  return c.json({ success: true, data: rest });
});

clinicRouter.put('/:businessType', withBusinessAccess('owner'), async (c) => {
  const parsed = validateClinicFeatures(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ success: false, error: parsed }, 400);
  try {
    const { businessType: _b, createdAt: _c, updatedAt: _u, ...rest } = await saveClinicFeatures(c.env, c.req.param('businessType')!, parsed);
    return c.json({ success: true, data: rest });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || 'Could not save' }, e?.status ?? 500);
  }
});

// POST /clinic/:businessType/visits/:orderId { status: 'completed' | 'no_show' | null }
clinicRouter.post('/:businessType/visits/:orderId', withBusinessAccess('staff'), async (c) => {
  const b = await c.req.json().catch(() => null) as any;
  const status = b?.status === null ? null : ['completed', 'no_show'].includes(b?.status) ? b.status : undefined;
  if (status === undefined) return c.json({ success: false, error: "status must be 'completed', 'no_show' or null" }, 400);
  const ok = await markVisit(c.env, c.req.param('businessType')!, c.req.param('orderId')!, status);
  return ok ? c.json({ success: true }) : c.json({ success: false, error: 'Appointment not found' }, 404);
});

export const clinicAdminRouter = new Hono<HonoEnv>();

// POST /admin/clinic/run { now? } — recalls, no-show recovery and review requests now.
// `now` (ISO time, to test timing) is refused in production.
clinicAdminRouter.post('/run', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  let now = new Date();
  if (body?.now !== undefined) {
    if (isProduction(c.env)) return c.json({ success: false, error: 'now can only be set outside production' }, 400);
    now = new Date(String(body.now));
    if (Number.isNaN(now.getTime())) return c.json({ success: false, error: 'now must be an ISO time' }, 400);
  }
  return c.json({ success: true, data: await runClinicFollowUps(c.env, now) });
});
