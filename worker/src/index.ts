import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import { getSectors } from './services/sector.service';
import type { HonoEnv } from './middleware';
import { authRouter } from './routes/auth';
import { accountRouter } from './routes/account';
import { catalogRouter } from './routes/catalog';
import { ordersRouter } from './routes/orders';
import { mogiRouter } from './routes/mogi';
import { twilioRouter } from './routes/twilio';
import { exotelRouter } from './routes/exotel';
import { plivoRouter } from './routes/plivo';
import { adminRouter } from './routes/admin';
import { whatsappRouter } from './routes/whatsapp';
import { calendarAdminRouter, oauthRouter } from './routes/calendar';
import { billingRouter, billingAdminRouter, razorpayRouter } from './routes/billing';
import { closePeriod } from './services/billing/service';
import type { Env } from './types';
import { isAllowedOrigin } from './utils/origins';
import { privacyAdminRouter } from './routes/privacy';
import { applyRetention } from './services/retention.service';

export { CallRelay } from './durable-objects/call-relay';

type AppEnv = HonoEnv & { Variables: { requestId: string } };
const app = new Hono<AppEnv>();

// Re-exported for tests (test/security.test.ts, test/accounts.test.ts).
export { isAllowedOrigin, app };

app.use('*', requestId());
// Skipped on the media-stream upgrade: its 101 response comes straight from
// the Durable Object and its headers can't be modified.
const STREAM_PATHS = new Set(['/twilio/stream', '/exotel/stream', '/plivo/stream']);
app.use('*', async (c, next) => (STREAM_PATHS.has(c.req.path) ? next() : secureHeaders()(c, next)));

// ── CORS ───────────────────────────────────────────────────────────────────
app.use('*', cors({
  origin: (origin, c) => (origin && isAllowedOrigin(origin, c.env) ? origin : null),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Mogi-Secret', 'X-Dev-Customer-Id', 'X-Admin-Key'],
}));

// ── Routes ─────────────────────────────────────────────────────────────────
// Sub-routers are typed with HonoEnv; the extra requestId variable is a
// superset, so mounting them is safe.
app.route('/auth',     authRouter);
app.route('/account',  accountRouter);
app.route('/catalog',  catalogRouter);
app.route('/orders',   ordersRouter);
app.route('/mogi',     mogiRouter);
app.route('/twilio',   twilioRouter);
app.route('/exotel',   exotelRouter);
app.route('/plivo',    plivoRouter);
app.route('/admin/calendar', calendarAdminRouter);
app.route('/admin/privacy', privacyAdminRouter);
app.route('/admin/billing', billingAdminRouter);
app.route('/admin',    adminRouter);
app.route('/oauth',    oauthRouter);
app.route('/whatsapp', whatsappRouter);
app.route('/billing',  billingRouter);
app.route('/razorpay', razorpayRouter);

// ── Health check ───────────────────────────────────────────────────────────
// Liveness by default; `?deep=1` also checks D1 and KV so uptime monitors
// and the post-deploy smoke test can catch broken bindings.
app.get('/health', async (c) => {
  if (!c.req.query('deep')) return c.json({ status: 'ok' });
  const checks = await Promise.allSettled([
    c.env.DB.prepare('SELECT 1').first(),
    c.env.CACHE.get('health:probe'),
  ]);
  const [db, kv] = checks.map(r => (r.status === 'fulfilled' ? 'ok' : 'error'));
  const ok = db === 'ok' && kv === 'ok';
  return c.json({ status: ok ? 'ok' : 'degraded', db, kv }, ok ? 200 : 503);
});

// ── Sectors list (public) ───────────────────────────────────────────────────
app.get('/sectors', async (c) => {
  const sectors = await getSectors(c.env);
  return c.json({
    success: true,
    data: Object.entries(sectors).map(([key, meta]) => ({
      key, name: meta.name, model: meta.model,
      // How the admin UI shows this business's prices, dates and phone numbers.
      currency: meta.currency, locale: meta.locale ?? 'en-US', countryCode: meta.countryCode ?? 'US',
    })),
  });
});

// ── Global error handler ───────────────────────────────────────────────────
app.onError((err, c) => {
  const id = c.get('requestId');
  console.error(JSON.stringify({
    level: 'error', msg: 'unhandled', requestId: id, method: c.req.method, path: c.req.path,
    error: err.message, stack: err.stack,
  }));
  return c.json({ success: false, error: 'Internal server error', requestId: id }, 500);
});

app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

// Cron Triggers ([triggers] in wrangler.toml), once a day:
// - data-retention sweep: a no-op until a business sets sectors.retention_days;
// - month-end overage billing: idempotent (failed rows retry the next day) and
//   only touches businesses with a billing plan.
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(applyRetention(env).then(() => undefined)
    .catch(e => console.error('[retention] sweep failed', e?.message || e)));
  ctx.waitUntil(
    closePeriod(env)
      .then(r => { if (r.length) console.log('[billing] close-period', JSON.stringify(r)); })
      .catch(e => console.error('[billing] close-period failed', e?.message || e)),
  );
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
