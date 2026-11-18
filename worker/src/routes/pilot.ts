import { Hono } from 'hono';
import { withBusinessAccess, type HonoEnv } from '../middleware';
import {
  CLINIC_LINES, forwardingTestResult, getPilotConfig, pilotActive, recentRoutes, savePilotConfig,
  startForwardingTest, validatePilotInput,
} from '../services/pilot';
import { getSector } from '../services/sector.service';
import { getDb } from '../db/client';
import { phoneNumbers } from '../db/schema';
import { eq } from 'drizzle-orm';

// /pilot/:businessType — overflow-only pilot on the clinic's own number.
// Owners (and the operator) set the dates and the clinic's number, run the
// "test your forwarding" check, and see recent forwarded calls.

export const pilotRouter = new Hono<HonoEnv>();

pilotRouter.get('/:businessType', withBusinessAccess('staff'), async (c) => {
  const bt = c.req.param('businessType')!;
  const cfg = await getPilotConfig(c.env, bt);
  const tz = (await getSector(c.env, bt))?.timezone || 'Asia/Kolkata';
  const numbers = await getDb(c.env.DB).select({ number: phoneNumbers.number, provider: phoneNumbers.provider })
    .from(phoneNumbers).where(eq(phoneNumbers.businessType, bt));
  const routes = await recentRoutes(c.env, bt, 20);
  return c.json({ success: true, data: {
    config: cfg && {
      enabled: cfg.enabled, mode: cfg.mode, startsOn: cfg.startsOn, endsOn: cfg.endsOn,
      clinicNumber: cfg.clinicNumber, clinicLine: cfg.clinicLine,
    },
    active: pilotActive(cfg, new Date(), tz),
    averyNumbers: numbers,            // where the clinic forwards to
    clinicLines: CLINIC_LINES,
    recent: routes.map(r => ({ at: r.createdAt, carrier: r.carrier, isOverflow: r.isOverflow, reason: r.reason, forwardedFrom: r.forwardedFrom })),
    forwardingTest: await forwardingTestResult(c.env, bt),
  } });
});

pilotRouter.put('/:businessType', withBusinessAccess('owner'), async (c) => {
  const parsed = validatePilotInput(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ success: false, error: parsed }, 400);
  const cfg = await savePilotConfig(c.env, c.req.param('businessType')!, parsed);
  return c.json({ success: true, data: cfg });
});

// "Test your forwarding": opens a 15-minute window; the next call that reaches
// Avery for this business (forwarded from the clinic's line) completes it.
pilotRouter.post('/:businessType/forwarding-test', withBusinessAccess('owner'), async (c) => {
  await startForwardingTest(c.env, c.req.param('businessType')!);
  return c.json({ success: true, data: await forwardingTestResult(c.env, c.req.param('businessType')!) });
});

pilotRouter.get('/:businessType/forwarding-test', withBusinessAccess('staff'), async (c) =>
  c.json({ success: true, data: await forwardingTestResult(c.env, c.req.param('businessType')!) }));
