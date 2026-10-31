import { Hono, type Context, type Next } from 'hono';
import type { HonoEnv } from '../middleware';
import { withTwilioSession } from '../middleware';
import { runTurn, loadHistory } from '../services/turn.service';
import { classifyCall } from '../services/call-classifier.service';
import { customerHashSalt, isProduction, timingSafeEqual } from '../config';
import { signStreamToken } from '../utils/stream-token';
import { hashId } from '../utils/identity';
import { transferKey } from '../services/call-context';

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

export function twilioSignedUrl(webhookUrl: string, path: string, requestUrl: string): string {
  return `${webhookUrl.replace(/\/$/, '')}${path}${new URL(requestUrl).search}`;
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

// Fails closed in production: a missing TWILIO_AUTH_TOKEN/TWILIO_WEBHOOK_URL
// must not silently turn signature checking off.
async function checkSig(c: Context<HonoEnv>, path: string): Promise<boolean> {
  const authToken  = c.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = c.env.TWILIO_WEBHOOK_URL;
  if (c.env.NODE_ENV === 'development') return true;
  if (!authToken || !webhookUrl) {
    if (isProduction(c.env)) {
      console.error('[twilio] TWILIO_AUTH_TOKEN / TWILIO_WEBHOOK_URL not set — rejecting webhook');
      return false;
    }
    return true;
  }
  const body      = await c.req.parseBody();
  const signature = c.req.header('x-twilio-signature') ?? '';
  // Twilio signs the full URL it called, including any query string.
  const url = twilioSignedUrl(webhookUrl, path, c.req.url);
  return validateTwilioSignature(authToken, signature, url, body as Record<string, string>);
}

function requireTwilioSig(path: string) {
  return async (c: Context<HonoEnv>, next: Next) => {
    if (!await checkSig(c, path)) {
      return c.text('<?xml version="1.0"?><Response><Say>Forbidden.</Say></Response>', 403, TEXT_XML);
    }
    await next();
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
  // Every caller used to share TWILIO_DEFAULT_CUSTOMER_HASH, so one caller
  // could hear — and cancel — another's bookings. Key them by their own
  // number instead (digits only — the same key WhatsApp hashes, so a
  // customer is one identity across both); a withheld number gets a
  // per-call identity.
  const body = await c.req.parseBody();
  const from = typeof body.From === 'string' ? body.From.trim() : '';
  const callSid = typeof body.CallSid === 'string' ? body.CallSid : crypto.randomUUID();
  const callerKey = /^\+?\d{7,15}$/.test(from) ? from.replace(/\D/g, '') : `call:${callSid}`;
  const callerHash = await hashId(callerKey, customerHashSalt(c.env));
  const callerPhone = /^\+\d{7,15}$/.test(from) ? from : undefined;
  const streamToken = await signStreamToken(c.env, businessType, callerHash, callerPhone);
  // When the stream ends Twilio moves on to the next verb: /after-stream
  // either transfers the call to staff (the agent asked for it) or hangs up.
  const afterUrl = `${(c.env.TWILIO_WEBHOOK_URL ?? `https://${host}`).replace(/\/$/, '')}/twilio/after-stream`;
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">` +
    `<Parameter name="businessType" value="${xml(businessType)}"/>` +
    `<Parameter name="streamToken" value="${xml(streamToken)}"/></Stream></Connect>` +
    `<Redirect method="POST">${xml(afterUrl)}</Redirect></Response>`,
    200, TEXT_XML,
  );
});

// ── POST /twilio/after-stream ─────────────────────────────────────────────────
// Reached when the media stream closes on a live call. CallRelay records a
// transfer request in KV (transferKey) before closing the stream.

twilioRouter.post('/after-stream', requireTwilioSig('/twilio/after-stream'), async (c) => {
  const body = await c.req.parseBody();
  const callSid = typeof body.CallSid === 'string' ? body.CallSid : '';
  const to = callSid ? await c.env.CACHE.get(transferKey(callSid)) : null;
  if (!to) return c.text('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', 200, TEXT_XML);
  console.log(`[call] ${callSid.slice(-8)} transferring to staff`);
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="25">${xml(to)}</Dial>` +
    `<Say voice="Polly.Joanna-Neural">Sorry, nobody was able to pick up. Please try again during business hours. Goodbye.</Say></Response>`,
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
    const { spokenResponse } = await runTurn(c.env, session, callSid, utterance, {
      background: (p) => c.executionCtx.waitUntil(p),
    });
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
