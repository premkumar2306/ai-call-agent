import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import { getSectors } from './services/sector.service';
import type { HonoEnv } from './middleware';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { ordersRouter } from './routes/orders';
import { mogiRouter } from './routes/mogi';
import { twilioRouter } from './routes/twilio';
import { adminRouter } from './routes/admin';
import { whatsappRouter } from './routes/whatsapp';
import { calendarAdminRouter, oauthRouter } from './routes/calendar';
import { isAllowedOrigin } from './utils/origins';

export { CallRelay } from './durable-objects/call-relay';

type AppEnv = HonoEnv & { Variables: { requestId: string } };
const app = new Hono<AppEnv>();

// Re-exported for tests (test/security.test.ts).
export { isAllowedOrigin };

app.use('*', requestId());
// Skipped on the media-stream upgrade: its 101 response comes straight from
// the Durable Object and its headers can't be modified.
app.use('*', async (c, next) => (c.req.path === '/twilio/stream' ? next() : secureHeaders()(c, next)));

// ── CORS ───────────────────────────────────────────────────────────────────
app.use('*', cors({
  origin: (origin, c) => (origin && isAllowedOrigin(origin, c.env) ? origin : null),
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Mogi-Secret', 'X-Dev-Customer-Id', 'X-Admin-Key'],
}));

// ── Routes ─────────────────────────────────────────────────────────────────
// Sub-routers are typed with HonoEnv; the extra requestId variable is a
// superset, so mounting them is safe.
app.route('/auth',     authRouter);
app.route('/catalog',  catalogRouter);
app.route('/orders',   ordersRouter);
app.route('/mogi',     mogiRouter);
app.route('/twilio',   twilioRouter);
app.route('/admin/calendar', calendarAdminRouter);
app.route('/admin',    adminRouter);
app.route('/oauth',    oauthRouter);
app.route('/whatsapp', whatsappRouter);

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
    data: Object.entries(sectors).map(([key, meta]) => ({ key, name: meta.name, model: meta.model })),
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

export default app;
