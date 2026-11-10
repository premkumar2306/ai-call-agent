import { Hono, type Context, type Next } from 'hono';
import type { HonoEnv } from '../middleware';
import { isProduction, timingSafeEqual } from '../config';
import { signCompactStreamToken, verifyCompactStreamToken } from '../utils/stream-token';
import { businessForNumber, normalizeE164 } from '../services/phone-numbers';
import { transferKey } from '../services/call-context';
import { PREAUTH_HEADER, PROVIDER_HEADER } from '../telephony';

// Exotel (Indian numbers). An ExoPhone's call flow, built in Exotel's App
// Bazaar, is:
//
//   Voicebot applet  ── URL: https://<worker>/exotel/voicebot   (dynamic: returns the wss URL)
//        │                 or wss://avery:<secret>@<worker>/exotel/stream (static)
//        ▼ (stream closed by Avery)
//   Passthru applet  ── https://<worker>/exotel/after-stream
//        │ 200 → Connect applet ── dial-whom URL https://<worker>/exotel/connect
//        │ 302 → Hangup
//
// Exotel doesn't sign its webhooks, so every endpoint here needs the shared
// EXOTEL_WEBHOOK_SECRET, given either as HTTP Basic auth in the configured URL
// (https://avery:<secret>@host/…) or as ?key=<secret>. Without the secret
// configured, production rejects everything (fails closed).
// See README → "Indian numbers (Exotel)".

const exotelRouter = new Hono<HonoEnv>();

/** True if the request carries the shared secret as ?key= or Basic-auth password. */
export function exotelSecretMatches(secret: string, query: URLSearchParams, authorization: string | undefined): boolean {
  const key = query.get('key');
  if (key && timingSafeEqual(key, secret)) return true;
  const m = /^Basic\s+(.+)$/i.exec(authorization ?? '');
  if (!m) return false;
  let decoded: string;
  try { decoded = atob(m[1].trim()); } catch { return false; }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return decoded.includes(':') && timingSafeEqual(password, secret);
}

function exotelAuthorized(c: Context<HonoEnv>): boolean {
  if (c.env.NODE_ENV === 'development') return true;
  const secret = c.env.EXOTEL_WEBHOOK_SECRET;
  if (!secret) {
    if (isProduction(c.env)) {
      console.error('[exotel] EXOTEL_WEBHOOK_SECRET not set — rejecting request');
      return false;
    }
    return true;
  }
  return exotelSecretMatches(secret, new URL(c.req.url).searchParams, c.req.header('authorization'));
}

async function requireExotelAuth(c: Context<HonoEnv>, next: Next) {
  if (!exotelAuthorized(c)) return c.text('Forbidden', 403);
  await next();
}

// Exotel sends applet webhooks as GET query params (POST form for some
// applets); read both. Parameter names vary by applet (CallFrom/From).
async function exotelParams(c: Context<HonoEnv>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) out[k] = v;
  if (c.req.method === 'POST') {
    const body = await c.req.parseBody().catch(() => ({}));
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  delete out.key;
  return out;
}

const pick = (p: Record<string, string>, ...names: string[]) => names.map(n => p[n]).find(v => v && v.trim())?.trim();

/** The business answering an Exotel number: phone_numbers row, else EXOTEL_DEFAULT_BUSINESS_TYPE. */
export async function exotelBusinessFor(env: HonoEnv['Bindings'], called: string | undefined): Promise<string | null> {
  return (await businessForNumber(env, 'exotel', called)) ?? env.EXOTEL_DEFAULT_BUSINESS_TYPE ?? null;
}

// ── GET|POST /exotel/voicebot ─────────────────────────────────────────────────
// The Voicebot applet's dynamic URL: returns {"url": "wss://…"} with a
// short-lived token bound to this CallSid and the business for the called
// ExoPhone, so the stream itself needs no shared secret in its URL.

exotelRouter.on(['GET', 'POST'], '/voicebot', requireExotelAuth, async (c) => {
  const p = await exotelParams(c);
  const callSid = pick(p, 'CallSid', 'call_sid');
  if (!callSid) return c.json({ error: 'CallSid required' }, 400);
  const called = pick(p, 'CallTo', 'To', 'DialWhomNumber');
  const businessType = await exotelBusinessFor(c.env, called);
  if (!businessType) {
    console.error(`[exotel] no business mapped to ${called ?? '(unknown number)'} and no EXOTEL_DEFAULT_BUSINESS_TYPE`);
    return c.json({ error: 'This number is not configured' }, 404);
  }
  const from = normalizeE164(pick(p, 'CallFrom', 'From'), '91') ?? undefined;
  const token = await signCompactStreamToken(c.env, { callSid, businessType, from });
  if (token.length > 250) console.warn(`[exotel] stream token is ${token.length} chars; Exotel truncates query strings over 256 — use a shorter business key`);
  return c.json({ url: `wss://${c.req.header('host')}/exotel/stream?t=${token}` });
});

// ── GET /exotel/stream ────────────────────────────────────────────────────────
// Exotel's Voicebot WebSocket → a per-call CallRelay Durable Object speaking
// the Exotel protocol. Authenticated by the ?t= token from /exotel/voicebot
// (re-checked against the call in CallRelay) or, for a static stream URL, by
// Basic auth carrying EXOTEL_WEBHOOK_SECRET.

exotelRouter.get('/stream', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426);

  const url = new URL(c.req.url);
  const token = url.searchParams.get('t');
  let preauth = false;
  if (token) {
    if (!(await verifyCompactStreamToken(c.env, token))) return c.text('Unauthorized', 401);
  } else {
    const secret = c.env.EXOTEL_WEBHOOK_SECRET;
    preauth = !!secret && exotelSecretMatches(secret, url.searchParams, c.req.header('authorization'));
    if (!preauth && isProduction(c.env)) return c.text('Unauthorized', 401);
  }

  const forwarded = new Request(c.req.raw);
  forwarded.headers.set(PROVIDER_HEADER, 'exotel');
  forwarded.headers.delete(PREAUTH_HEADER);
  if (preauth) forwarded.headers.set(PREAUTH_HEADER, '1');
  const stub = c.env.RELAY_DO.get(c.env.RELAY_DO.idFromName(crypto.randomUUID()));
  return stub.fetch(forwarded);
});

// ── GET|POST /exotel/after-stream ─────────────────────────────────────────────
// Passthru applet after the Voicebot: 200 when the agent asked to transfer
// the caller to staff (→ Connect applet), 302 otherwise (→ Hangup).

exotelRouter.on(['GET', 'POST'], '/after-stream', requireExotelAuth, async (c) => {
  const callSid = pick(await exotelParams(c), 'CallSid');
  const to = callSid ? await c.env.CACHE.get(transferKey(callSid)) : null;
  if (!to) return c.body(null, 302);
  console.log(`[call] ${callSid!.slice(-8)} transferring to staff (exotel)`);
  return c.text('transfer', 200);
});

// ── GET|POST /exotel/connect ──────────────────────────────────────────────────
// Connect applet's dynamic "dial whom" URL: the staff number CallRelay saved.

exotelRouter.on(['GET', 'POST'], '/connect', requireExotelAuth, async (c) => {
  const callSid = pick(await exotelParams(c), 'CallSid');
  const raw = callSid ? await c.env.CACHE.get(transferKey(callSid)) : null;
  const number = normalizeE164(raw, '91');
  if (!number) return c.json({ error: 'No transfer requested for this call' }, 404);
  return c.json({
    fetch_after_attempt: false,
    destination: { numbers: [number] },
    max_ringing_duration: 25,
  });
});

export { exotelRouter };
