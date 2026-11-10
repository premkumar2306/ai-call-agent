import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /admin/sectors: locale fields are validated and passed through, and
// omitted ones stay undefined so an existing business keeps its locale.

const upserts: any[] = [];
vi.mock('../src/services/sector.service', () => ({
  getSectors: async () => ({}),
  getSector: async () => null,
  upsertSector: async (_env: unknown, key: string, data: unknown) => { upserts.push({ key, data }); },
}));

const { adminRouter } = await import('../src/routes/admin');

const env = { ADMIN_SECRET: 'test-admin-secret' } as any;
const post = (body: Record<string, unknown>) => adminRouter.request('/sectors', {
  method: 'POST',
  headers: { 'X-Admin-Key': 'test-admin-secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'sharma_dental', name: 'Sharma Dental', hours: { mon: '10am–7pm' }, ...body }),
}, env);

beforeEach(() => { upserts.length = 0; });

describe('POST /admin/sectors locale fields', () => {
  it('saves an Indian locale', async () => {
    const res = await post({ currency: 'INR', locale: 'en-IN', country_code: 'IN', timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(200);
    expect(upserts[0].data).toMatchObject({ currency: 'INR', locale: 'en-IN', countryCode: 'IN', timezone: 'Asia/Kolkata' });
  });

  it('leaves omitted locale fields unset so they are not overwritten', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(upserts[0].data.currency).toBeUndefined();
    expect(upserts[0].data.locale).toBeUndefined();
    expect(upserts[0].data.countryCode).toBeUndefined();
    expect(upserts[0].data.timezone).toBe('America/Chicago'); // unchanged legacy default
  });

  it('rejects invalid values with a 400 and saves nothing', async () => {
    const res = await post({ currency: 'rupees', locale: 'en-IN', country_code: 'India', timezone: 'IST/Nowhere' });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toContain('currency');
    expect(json.error).toContain('country_code');
    expect(json.error).toContain('timezone');
    expect(json.error).not.toContain('locale');
    expect(upserts).toHaveLength(0);
  });
});
