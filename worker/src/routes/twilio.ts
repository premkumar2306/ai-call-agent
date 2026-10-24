import { Hono, type Context, type Next } from 'hono';
import type { HonoEnv } from '../middleware';
import { withTwilioSession } from '../middleware';
import { runTurn, loadHistory } from '../services/turn.service';
import { classifyCall } from '../services/call-classifier.service';
import { isProduction, timingSafeEqual } from '../config';
import { signStreamToken } from '../utils/stream-token';

const twilioRouter = new Hono<HonoEnv>();

// ── Helpers ───────────────────────────────────────────────────────────────────

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function validateTwilioSignature(
  authToken: string, signature: string, url: string, params: Record<string, string>
): Promise<boolean> {
  const sorted = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sorted));
  return timingSafeEqual(btoa(String.fromCharCode(...new Uint8Array(sig))), signature);
}

function twiml(say: string, gatherAction?: string): string {
  const gather = gatherAction
    ? `<Gather input="speech" action="${xml(gatherAction)}" speechTimeout="3" language="en-US" enhanced="true"></Gather>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${xml(say)}</Say>
  ${gather}
</Response>`;
}

function xml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TEXT_XML = { 'Content-Type': 'text/xml' };

// Three outcomes, not two. "We are misconfigured" and "this request is not
// from Twilio" both used to collapse into a bare 403, which Twilio renders to
// the caller as "an application error has occurred" — identical for an
// operator mistake and an attack, and diagnosable only by finding the logs.
type SigCheck =
  | { ok: true }
  | { ok: false; reason: 'misconfigured'; missing: string[] }
  | { ok: false; reason: 'bad_signature' };

// Fails closed in production: a missing TWILIO_AUTH_TOKEN/TWILIO_WEBHOOK_URL
// must not silently turn signature checking off.
async function checkSig(c: Context<HonoEnv>, path: string): Promise<SigCheck> {
  const authToken  = c.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = c.env.TWILIO_WEBHOOK_URL;
  if (c.env.NODE_ENV === 'development') return { ok: true };
  if (!authToken || !webhookUrl) {
    const missing = [
      !authToken && 'TWILIO_AUTH_TOKEN',
      !webhookUrl && 'TWILIO_WEBHOOK_URL',
    ].filter(Boolean) as string[];
    if (isProduction(c.env)) return { ok: false, reason: 'misconfigured', missing };
    return { ok: true };
  }
  const body      = await c.req.parseBody();
  const signature = c.req.header('x-twilio-signature') ?? '';
  // Twilio signs the full URL it called, including any query string.
  const url = `${webhookUrl.replace(/\/$/, '')}${path}${new URL(c.req.url).search}`;
  if (await validateTwilioSignature(authToken, signature, url, body as Record<string, string>)) {
    return { ok: true };
  }
  // By far the most common cause is TWILIO_WEBHOOK_URL not matching the host
  // Twilio actually dialled — after a Worker rename, a custom domain, or a
  // console URL edit. The signature is over the URL string, so a host that
  // differs by one character fails exactly like a forged request. Log both so
  // a single `wrangler tail` line settles which it is. No secrets here: the
  // URLs are public and the signature is already a public request header.
  const actual = new URL(c.req.url);
  console.error(JSON.stringify({
    level: 'error', msg: 'twilio signature mismatch', path,
    signedUrl: url,
    requestUrl: `${actual.origin}${actual.pathname}${actual.search}`,
    hostMatches: actual.origin === new URL(webhookUrl).origin,
    hasSignatureHeader: signature.length > 0,
  }));
  return { ok: false, reason: 'bad_signature' };
}

function requireTwilioSig(path: string) {
  return async (c: Context<HonoEnv>, next: Next) => {
    const check = await checkSig(c, path);
    if (check.ok) return await next();

    if (check.reason === 'misconfigured') {
      // Our fault, not the caller's and not an attacker's. Say so out loud in
      // the logs, and tell the caller something true instead of letting
      // Twilio play its generic application-error message. Still no agent and
      // no tool access, so this concedes nothing to someone probing the
      // endpoint — they learn only that the line is down, which the generic
      // error already told them.
      console.error(`[twilio] ${check.missing.join(' and ')} not set — rejecting webhook. `
        + 'Set with: wrangler secret put <NAME>. TWILIO_WEBHOOK_URL must be the exact public '
        + 'base URL Twilio dials, e.g. https://mogi-platform.<account>.workers.dev');
      return c.text(
        '<?xml version="1.0"?><Response><Say>This line is not fully configured yet. '
        + 'Please try again later.</Say></Response>',
        200, TEXT_XML,
      );
    }

    return c.text('<?xml version="1.0"?><Response><Say>Forbidden.</Say></Response>', 403, TEXT_XML);
  };
}

// ── POST /twilio/inbound ──────────────────────────────────────────────────────

twilioRouter.post('/inbound', requireTwilioSig('/twilio/inbound'), withTwilioSession, async (c) => {
  const { businessType } = c.get('session');
  const host       = c.req.header('host');
  // businessType is passed both ways: as a <Parameter> (the reliable mechanism —
  // arrives in the 'start' event's customParameters) and as a query-string fallback
  // (query strings on <Stream url> aren't reliably forwarded by Twilio's real client,
  // but our own synthetic test harness relies on it).
  const streamUrl  = `wss://${host}/twilio/stream?businessType=${encodeURIComponent(businessType)}`;

  // tokenSecretKey() throws when TOKEN_SECRET is unset or under 32 chars in
  // production. Unhandled, that becomes a 500 and Twilio plays its generic
  // application-error message — the same thing the caller hears for every
  // other fault, with nothing naming the cause.
  let streamToken: string;
  try {
    streamToken = await signStreamToken(c.env, businessType);
  } catch (err: any) {
    console.error(`[twilio] cannot mint stream token: ${err?.message || err}. `
      + 'Set a TOKEN_SECRET of at least 32 characters: wrangler secret put TOKEN_SECRET');
    return c.text(
      '<?xml version="1.0"?><Response><Say>This line is not fully configured yet. '
      + 'Please try again later.</Say></Response>',
      200, TEXT_XML,
    );
  }

  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">` +
    `<Parameter name="businessType" value="${xml(businessType)}"/>` +
    `<Parameter name="streamToken" value="${xml(streamToken)}"/></Stream></Connect></Response>`,
    200, TEXT_XML,
  );
});

// ── GET /twilio/stream ─────────────────────────────────────────────────────
// Twilio Media Streams WebSocket — upgrades into a per-call CallRelay Durable Object.

twilioRouter.get('/stream', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected websocket', 426);
  }
  const id   = c.env.RELAY_DO.idFromName(crypto.randomUUID());
  const stub = c.env.RELAY_DO.get(id);
  return stub.fetch(c.req.raw);
});

// ── POST /twilio/turn ─────────────────────────────────────────────────────────

twilioRouter.post('/turn', requireTwilioSig('/twilio/turn'), withTwilioSession, async (c) => {
  const session = c.get('session');
  const body    = await c.req.parseBody();
  const token   = c.req.query('token');
  const turnUrl = token ? `/twilio/turn?token=${encodeURIComponent(token)}` : '/twilio/turn';
  const callSid = (body.CallSid as string | undefined) ?? `web-${Date.now()}`;

  const utterance = ((body.SpeechResult as string) ?? '').trim();
  if (!utterance) {
    return c.text(twiml("I didn't catch that. Could you say that again?", turnUrl), 200, TEXT_XML);
  }

  try {
    const { spokenResponse } = await runTurn(c.env, session, callSid, utterance, undefined, undefined,
      (p) => c.executionCtx.waitUntil(p));
    return c.text(twiml(spokenResponse, turnUrl), 200, TEXT_XML);
  } catch (err: any) {
    console.error(`[${callSid.slice(-8)}] error:`, err.message);
    return c.text(twiml("I'm having technical difficulties. Please try again.", turnUrl), 200, TEXT_XML);
  }
});

// ── POST /twilio/status ───────────────────────────────────────────────────────
// Twilio fires this when a call ends. We classify the full transcript here so
// per-turn latency is never affected by the classifier.

twilioRouter.post('/status', requireTwilioSig('/twilio/status'), async (c) => {
  const body       = await c.req.parseBody();
  const callSid    = body.CallSid as string | undefined;
  const callStatus = body.CallStatus as string | undefined;

  if (!callSid || callStatus !== 'completed') return c.text('ok', 200);

  // Classify after responding so Twilio gets its 200 immediately. waitUntil
  // keeps the isolate alive until this finishes — a bare floating promise
  // can be cancelled as soon as the response is sent.
  c.executionCtx.waitUntil((async () => {
    try {
      const history = await loadHistory(c.env, callSid);
      if (!history.length) return;

      const combinedTranscript = history
        .map(t => `${t.role === 'user' ? 'MEMBER' : 'AGENT'}: ${t.content}`)
        .join('\n');

      const clf = await classifyCall(combinedTranscript, c.env);
      await c.env.CART.put(`clf:completed:${callSid}`, JSON.stringify(clf), { expirationTtl: 86400 });

      console.log(`[${callSid.slice(-8)}] end-of-call clf: ${clf.primary_category}.${clf.primary_intent} (${clf.confidence.toFixed(2)}) flags=${clf.compliance_flags.join(',') || 'none'}`);
    } catch (e: any) {
      console.error(`[status] clf error ${callSid?.slice(-8)}:`, e.message);
    }
  })());

  return c.text('ok', 200);
});

export { twilioRouter };
