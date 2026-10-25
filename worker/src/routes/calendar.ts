import { Hono, type Context } from 'hono';
import type { HonoEnv } from '../middleware';
import { withAdminKey } from '../middleware';
import { getSector } from '../services/sector.service';
import { isAllowedOrigin } from '../utils/origins';
import {
  CalendarError, authUrl, connect, disconnect, getConnection, getProvider,
  listCalendars, listProviders, signOAuthState, updateConnectionSettings, verifyOAuthState,
} from '../services/calendar';

// Per-business calendar connections. Admin routes are mounted at
// /admin/calendar; the OAuth callback is public (the provider redirects the
// operator's browser to it) and mounted at /oauth.

const calendarAdminRouter = new Hono<HonoEnv>();
const oauthRouter = new Hono<HonoEnv>();

// The provider must be registered with exactly this URL, per provider:
// <worker origin>/oauth/<provider>/callback (e.g. /oauth/google/callback).
function redirectUri(c: Context<HonoEnv>, provider: string): string {
  return `${new URL(c.req.url).origin}/oauth/${provider}/callback`;
}

calendarAdminRouter.use('*', withAdminKey);

// GET /admin/calendar/:businessType — connection status and available providers
calendarAdminRouter.get('/:businessType', async (c) => {
  const businessType = c.req.param('businessType');
  const conn = await getConnection(c.env, businessType);
  return c.json({
    success: true,
    data: {
      providers: listProviders(c.env),
      connection: conn && {
        provider: conn.provider,
        accountEmail: conn.accountEmail,
        calendarId: conn.calendarId,
        calendarName: conn.calendarName,
        checkBusy: conn.checkBusy,
        writeEvents: conn.writeEvents,
        status: conn.status,
        lastError: conn.lastError,
        updatedAt: (conn.updatedAt as Date).toISOString(),
      },
    },
  });
});

// POST /admin/calendar/:businessType/:provider/connect { returnTo } → { url }
// The UI then sends the operator's browser to `url`.
calendarAdminRouter.post('/:businessType/:provider/connect', async (c) => {
  const { businessType, provider } = c.req.param();
  if (!getProvider(provider)) return c.json({ success: false, error: `Unknown calendar provider: ${provider}` }, 404);
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: `Unknown business: ${businessType}` }, 404);

  const body = await c.req.json().catch(() => ({}));
  let returnTo: URL;
  try {
    returnTo = new URL(body.returnTo);
  } catch {
    return c.json({ success: false, error: 'returnTo must be the admin UI URL' }, 400);
  }
  // Only ever send the operator back to the admin UI — never an arbitrary site.
  if (!isAllowedOrigin(returnTo.origin, c.env)) return c.json({ success: false, error: 'returnTo origin not allowed' }, 400);

  try {
    const state = await signOAuthState(c.env, { businessType, provider, returnTo: returnTo.toString() });
    return c.json({ success: true, data: { url: authUrl(c.env, provider, redirectUri(c, provider), state) } });
  } catch (e) {
    if (e instanceof CalendarError) return c.json({ success: false, error: e.message }, 503);
    throw e;
  }
});

// GET /admin/calendar/:businessType/calendars — calendars the account can write to
calendarAdminRouter.get('/:businessType/calendars', async (c) => {
  const conn = await getConnection(c.env, c.req.param('businessType'));
  if (!conn) return c.json({ success: false, error: 'No calendar connected' }, 404);
  try {
    return c.json({ success: true, data: await listCalendars(c.env, conn) });
  } catch (e) {
    if (e instanceof CalendarError) return c.json({ success: false, error: e.message }, 502);
    throw e;
  }
});

// PUT /admin/calendar/:businessType { calendarId?, calendarName?, checkBusy?, writeEvents? }
calendarAdminRouter.put('/:businessType', async (c) => {
  const businessType = c.req.param('businessType');
  if (!(await getConnection(c.env, businessType))) return c.json({ success: false, error: 'No calendar connected' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const settings: Parameters<typeof updateConnectionSettings>[2] = {};
  if (typeof body.calendarId === 'string' && body.calendarId) settings.calendarId = body.calendarId;
  if (typeof body.calendarName === 'string') settings.calendarName = body.calendarName;
  if (typeof body.checkBusy === 'boolean') settings.checkBusy = body.checkBusy;
  if (typeof body.writeEvents === 'boolean') settings.writeEvents = body.writeEvents;
  if (!Object.keys(settings).length) return c.json({ success: false, error: 'Nothing to update' }, 400);
  await updateConnectionSettings(c.env, businessType, settings);
  return c.json({ success: true });
});

// DELETE /admin/calendar/:businessType — revoke access and forget the connection
calendarAdminRouter.delete('/:businessType', async (c) => {
  await disconnect(c.env, c.req.param('businessType'));
  return c.json({ success: true });
});

// GET /oauth/:provider/callback?code&state — provider redirects here after consent
oauthRouter.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const state = await verifyOAuthState(c.env, c.req.query('state') ?? '');
  // No valid state: we don't know where it's safe to send the browser.
  if (!state || state.provider !== provider) return c.text('This calendar link has expired. Start again from the Mogi dashboard.', 400);

  const back = new URL(state.returnTo);
  back.searchParams.set('business', state.businessType);
  const code = c.req.query('code');
  if (!code) {
    back.searchParams.set('calendar', 'error');
    back.searchParams.set('reason', c.req.query('error') === 'access_denied' ? 'Access was declined' : 'No authorization code');
    return c.redirect(back.toString());
  }
  try {
    await connect(c.env, provider, state.businessType, code, redirectUri(c, provider));
    back.searchParams.set('calendar', 'connected');
  } catch (e: any) {
    console.error('[calendar] connect failed', state.businessType, e?.message || e);
    back.searchParams.set('calendar', 'error');
    back.searchParams.set('reason', e instanceof CalendarError ? e.message : 'Could not connect the calendar');
  }
  return c.redirect(back.toString());
});

export { calendarAdminRouter, oauthRouter };
