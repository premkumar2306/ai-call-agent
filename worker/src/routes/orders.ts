import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HonoEnv } from '../middleware';
import { withSession } from '../middleware';
import { placeOrder, getOrders, getOrder, cancelOrder } from '../services/order.service';

const ordersRouter = new Hono<HonoEnv>();

// Known business errors carry a safe message and map to a 4xx; anything
// else is unexpected, so log it and rethrow to the global 500 handler
// instead of echoing internal error text to the client.
function orderError(c: Context<HonoEnv>, err: any, statusByCode: Record<string, ContentfulStatusCode>) {
  const status = statusByCode[err?.code];
  if (status) return c.json({ success: false, error: err.message }, status);
  throw err;
}

// POST /orders
ordersRouter.post('/', withSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { product_id, payment_method, shipping_address } = body;
  if (!product_id || !payment_method) {
    return c.json({ success: false, error: 'product_id and payment_method required' }, 400);
  }
  try {
    const session = c.get('session');
    const order = await placeOrder(c.env, session.sub, session.businessType, product_id, payment_method, shipping_address);
    return c.json({ success: true, data: order }, 201);
  } catch (err: any) {
    return orderError(c, err, { NOT_FOUND: 404, INVALID_SECTOR: 404, ADDRESS_REQUIRED: 400 });
  }
});

// GET /orders
ordersRouter.get('/', withSession, async (c) => {
  const session = c.get('session');
  const orders = await getOrders(c.env, session.sub, session.businessType);
  return c.json({ success: true, data: { orders } });
});

// GET /orders/:id
ordersRouter.get('/:id', withSession, async (c) => {
  const session = c.get('session');
  const order = await getOrder(c.env, c.req.param('id') ?? '', session.sub);
  if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
  return c.json({ success: true, data: order });
});

// POST /orders/:id/cancel
ordersRouter.post('/:id/cancel', withSession, async (c) => {
  const session = c.get('session');
  try {
    const order = await cancelOrder(c.env, c.req.param('id') ?? '', session.sub);
    return c.json({ success: true, data: order });
  } catch (err: any) {
    return orderError(c, err, { NOT_FOUND: 404, INVALID_STATUS: 409 });
  }
});

export { ordersRouter };
