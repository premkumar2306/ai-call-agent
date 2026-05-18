import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { getSectors } from './services/sector.service';
import type { HonoEnv } from './middleware';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { ordersRouter } from './routes/orders';
import { averyRouter } from './routes/avery';
import { twilioRouter } from './routes/twilio';
import { adminRouter } from './routes/admin';
import { whatsappRouter } from './routes/whatsapp';

const app = new Hono<HonoEnv>();

// ── CORS ───────────────────────────────────────────────────────────────────
// Allow the production Pages domain, any Cloudflare Pages preview deploy
// (*.avery-admin.pages.dev), and local dev.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null;
    if (
      origin === 'https://avery-admin.pages.dev' ||
      origin.endsWith('.avery-admin.pages.dev') ||
      /^http:\/\/localhost:\d+$/.test(origin)
    ) return origin;
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Avery-Secret', 'X-Dev-Customer-Id', 'X-Admin-Key'],
}));

// ── Routes ─────────────────────────────────────────────────────────────────
app.route('/auth',    authRouter);
app.route('/catalog', catalogRouter);
app.route('/orders',  ordersRouter);
app.route('/avery',   averyRouter);
app.route('/twilio',    twilioRouter);
app.route('/admin',    adminRouter);
app.route('/whatsapp', whatsappRouter);

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', async (c) => {
  return c.json({ status: 'ok' });
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
  console.error('Unhandled error', c.req.path, err.message);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

export default app;
