import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { withSession } from '../middleware';
import { getProducts, getProductById } from '../services/catalog.service';

const catalogRouter = new Hono<HonoEnv>();

// GET /catalog?category=BRAKES
catalogRouter.get('/', withSession, async (c) => {
  const products = await getProducts(c.env, c.get('session').businessType, c.req.query('category'));
  return c.json({ success: true, data: { products, total: products.length } });
});

// GET /catalog/:id
catalogRouter.get('/:id', withSession, async (c) => {
  const product = await getProductById(c.env, c.req.param('id') ?? '');
  if (!product || product.businessType !== c.get('session').businessType) {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
  return c.json({ success: true, data: { product } });
});

export { catalogRouter };
