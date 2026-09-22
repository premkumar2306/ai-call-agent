import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { withTwilioSession } from '../middleware';
import { runTurn, loadHistory } from '../services/turn.service';
import {
  classifyCall,
  getCrisisResponse,
  getFollowUpQuestion,
  buildClassificationContext,
  type CallClassification,
} from '../services/call-classifier.service';
import type { Env } from '../types';

const twilioRouter = new Hono<HonoEnv>();

// ── Health-nav classification cache (CART KV, 1-hour TTL) ────────────────────

async function loadClassification(env: Env, callSid: string): Promise<CallClassification | null> {
  const raw = await env.CART.get(`clf:${callSid}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveClassification(env: Env, callSid: string, clf: CallClassification): Promise<void> {
  await env.CART.put(`clf:${callSid}`, JSON.stringify(clf), { expirationTtl: 3600 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function validateTwilioSignature(
  authToken: string, signature: string, url: string, params: Record<string, string>
): Promise<boolean> {
  const sorted = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sorted));
  return btoa(String.fromCharCode(...new Uint8Array(sig))) === signature;
}

function twiml(say: string, gatherAction?: string): string {
  const gather = gatherAction
    ? `<Gather input="speech" action="${gatherAction}" speechTimeout="3" language="en-US" enhanced="true"></Gather>`
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

async function checkSig(c: any, path: string): Promise<boolean> {
  const authToken  = c.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = c.env.TWILIO_WEBHOOK_URL;
  if (!authToken || !webhookUrl || c.env.NODE_ENV === 'development') return true;
  const body      = await c.req.parseBody();
  const signature = c.req.header('x-twilio-signature') ?? '';
  return validateTwilioSignature(authToken, signature, `${webhookUrl}${path}`, body as Record<string, string>);
}

// ── POST /twilio/inbound ──────────────────────────────────────────────────────

twilioRouter.post('/inbound', async (c, next) => {
  if (!await checkSig(c, '/twilio/inbound')) {
    return c.text('<?xml version="1.0"?><Response><Say>Forbidden.</Say></Response>', 403,
      { 'Content-Type': 'text/xml' });
  }
  await next();
}, withTwilioSession, async (c) => {
  const { businessType } = c.get('session');
  const host       = c.req.header('host');
  // businessType is passed both ways: as a <Parameter> (the reliable mechanism —
  // arrives in the 'start' event's customParameters) and as a query-string fallback
  // (query strings on <Stream url> aren't reliably forwarded by Twilio's real client,
  // but our own synthetic test harness relies on it).
  const streamUrl  = `wss://${host}/twilio/stream?businessType=${encodeURIComponent(businessType)}`;
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}">` +
    `<Parameter name="businessType" value="${xml(businessType)}"/></Stream></Connect></Response>`,
    200, { 'Content-Type': 'text/xml' },
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

twilioRouter.post('/turn', async (c, next) => {
  if (!await checkSig(c, '/twilio/turn')) {
    return c.text('<?xml version="1.0"?><Response><Say>Forbidden.</Say></Response>', 403,
      { 'Content-Type': 'text/xml' });
  }
  await next();
}, withTwilioSession, async (c) => {
  const session = c.get('session');
  const body    = await c.req.parseBody();
  const token   = c.req.query('token');
  const turnUrl = token ? `/twilio/turn?token=${encodeURIComponent(token)}` : '/twilio/turn';
  const callSid = (body.CallSid as string | undefined) ?? `web-${Date.now()}`;

  const utterance = ((body.SpeechResult as string) ?? '').trim();
  if (!utterance) {
    return c.text(twiml("I didn't catch that. Could you say that again?", turnUrl), 200,
      { 'Content-Type': 'text/xml' });
  }

  try {
    const { spokenResponse } = await runTurn(c.env, session, callSid, utterance);
    return c.text(twiml(spokenResponse, turnUrl), 200, { 'Content-Type': 'text/xml' });
  } catch (err: any) {
    console.error(`[${callSid.slice(-8)}] error:`, err.message);
    return c.text(twiml("I'm having technical difficulties. Please try again.", turnUrl), 200,
      { 'Content-Type': 'text/xml' });
  }
});

// ── POST /twilio/status ───────────────────────────────────────────────────────
// Twilio fires this when a call ends. We classify the full transcript here so
// per-turn latency is never affected by the classifier.

twilioRouter.post('/status', async (c) => {
  const body       = await c.req.parseBody();
  const callSid    = body.CallSid as string | undefined;
  const callStatus = body.CallStatus as string | undefined;

  if (!callSid || callStatus !== 'completed') return c.text('ok', 200);

  // Run classification fire-and-forget so we return 200 to Twilio immediately
  (async () => {
    try {
      const history = await loadHistory(c.env, callSid);
      if (!history.length) return;

      const combinedTranscript = history
        .map(t => `${t.role === 'user' ? 'MEMBER' : 'AGENT'}: ${t.content}`)
        .join('\n');

      const clf = await classifyCall(combinedTranscript, c.env.ANTHROPIC_API_KEY);
      await c.env.CART.put(`clf:completed:${callSid}`, JSON.stringify(clf), { expirationTtl: 86400 });

      console.log(`[${callSid.slice(-8)}] end-of-call clf: ${clf.primary_category}.${clf.primary_intent} (${clf.confidence.toFixed(2)}) flags=${clf.compliance_flags.join(',') || 'none'}`);
    } catch (e: any) {
      console.error(`[status] clf error ${callSid?.slice(-8)}:`, e.message);
    }
  })();

  return c.text('ok', 200);
});

export { twilioRouter };
