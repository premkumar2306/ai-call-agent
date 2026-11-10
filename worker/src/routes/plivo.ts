import { Hono, type Context, type Next } from 'hono';
import type { HonoEnv } from '../middleware';
import { customerHashSalt, isProduction, timingSafeEqual } from '../config';
import { signStreamToken } from '../utils/stream-token';
import { callerIdentity } from '../utils/identity';
import { businessForNumber, normalizeE164 } from '../services/phone-numbers';
import { transferKey } from '../services/call-context';
import { PREAUTH_HEADER, PROVIDER_HEADER } from '../telephony';

// Plivo (Indian numbers, alternative to Exotel). A Plivo application's
// Answer URL is POST https://<worker>/plivo/answer, which returns a
// bidirectional <Stream> to /plivo/stream; when the stream closes Plivo
// carries on to /plivo/after-stream (transfer to staff, or hang up).
// Webhooks are verified with X-Plivo-Signature-V3 (PLIVO_AUTH_TOKEN), and
// fail closed in production without it.

const plivoRouter = new Hono<HonoEnv>();

// https://www.plivo.com/docs/voice/concepts/signature-validation
// V3: base64(HMAC-SHA256(authToken, url[?sorted query] [.] sortedPostParams "." nonce))
export function plivoV3BaseString(method: string, url: string, params: Record<string, string>, nonce: string): string {
  const u = new URL(url);
  const query = [...u.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a < b ? -1 : 1));
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  if (method === 'GET') {
    const all = [...query, ...Object.entries(params)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (all.length) base += '?' + all.map(([k, v]) => `${k}=${v}`).join('&');
  } else {
    if (query.length) base += '?' + query.map(([k, v]) => `${k}=${v}`).join('&');
    const post = Object.keys(params).sort().map(k => k + params[k]).join('');
    if (query.length && post) base += '.';
    base += post;
  }
  return `${base}.${nonce}`;
}

export async function validatePlivoV3Signature(
  authToken: string, signatureHeader: string, nonce: string, method: string, url: string, params: Record<string, string>,
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plivoV3BaseString(method, url, params, nonce)));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signatureHeader.split(',').some(s => timingSafeEqual(s.trim(), expected));
}

async function formParams(c: Context<HonoEnv>): Promise<Record<string, string>> {
  if (c.req.method !== 'POST') return {};
  const body = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

// The URL Plivo signed: PLIVO_WEBHOOK_URL (public base) + path + query.
function signedUrl(c: Context<HonoEnv>, base: string): string {
  const u = new URL(c.req.url);
  return `${base.replace(/\/$/, '')}${u.pathname}${u.search}`;
}

async function requirePlivoSig(c: Context<HonoEnv>, next: Next) {
  if (c.env.NODE_ENV !== 'development') {
    const token = c.env.PLIVO_AUTH_TOKEN;
    const base = c.env.PLIVO_WEBHOOK_URL;
    if (!token || !base) {
      if (isProduction(c.env)) {
        console.error('[plivo] PLIVO_AUTH_TOKEN / PLIVO_WEBHOOK_URL not set — rejecting webhook');
        return c.text('Forbidden', 403);
      }
    } else {
      const ok = await validatePlivoV3Signature(
        token, c.req.header('x-plivo-signature-v3') ?? '', c.req.header('x-plivo-signature-v3-nonce') ?? '',
        c.req.method, signedUrl(c, base), await formParams(c),
      );
      if (!ok) return c.text('Forbidden', 403);
    }
  }
  await next();
}

const XML = { 'Content-Type': 'application/xml' };
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── POST /plivo/answer ────────────────────────────────────────────────────────

plivoRouter.post('/answer', requirePlivoSig, async (c) => {
  const p = await formParams(c);
  const host = c.req.header('host');
  const businessType = (await businessForNumber(c.env, 'plivo', p.To)) ?? c.env.PLIVO_DEFAULT_BUSINESS_TYPE;
  if (!businessType) {
    return c.text('<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This line is not configured. Goodbye.</Speak><Hangup/></Response>', 200, XML);
  }
  const callUuid = p.CallUUID || crypto.randomUUID();
  const { callerHash, callerPhone } = await callerIdentity(p.From, callUuid, customerHashSalt(c.env), (raw) => normalizeE164(raw, '91'));
  const token = await signStreamToken(c.env, businessType, callerHash, callerPhone);
  const base = (c.env.PLIVO_WEBHOOK_URL ?? `https://${host}`).replace(/\/$/, '');
  return c.text(
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xml(`wss://${host}/plivo/stream?token=${token}`)}</Stream>` +
    `<Redirect method="POST">${xml(`${base}/plivo/after-stream`)}</Redirect></Response>`,
    200, XML,
  );
});

// ── POST /plivo/after-stream ──────────────────────────────────────────────────

plivoRouter.post('/after-stream', requirePlivoSig, async (c) => {
  const callUuid = (await formParams(c)).CallUUID ?? '';
  const to = normalizeE164(callUuid ? await c.env.CACHE.get(transferKey(callUuid)) : null, '91');
  if (!to) return c.text('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', 200, XML);
  console.log(`[call] ${callUuid.slice(-8)} transferring to staff (plivo)`);
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="25"><Number>${xml(to.slice(1))}</Number></Dial>` +
    '<Speak>Sorry, nobody was able to pick up. Please try again during business hours. Goodbye.</Speak></Response>',
    200, XML,
  );
});

// ── GET /plivo/stream ─────────────────────────────────────────────────────────
// Authenticated in CallRelay by the ?token= minted in /plivo/answer.

plivoRouter.get('/stream', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426);
  const forwarded = new Request(c.req.raw);
  forwarded.headers.set(PROVIDER_HEADER, 'plivo');
  forwarded.headers.delete(PREAUTH_HEADER);
  const stub = c.env.RELAY_DO.get(c.env.RELAY_DO.idFromName(crypto.randomUUID()));
  return stub.fetch(forwarded);
});

export { plivoRouter };
