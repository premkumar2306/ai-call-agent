import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { withTwilioSession } from '../middleware';
import { getSector } from '../services/sector.service';
import { getProducts } from '../services/catalog.service';
import { getOrders } from '../services/order.service';
import { scoreProducts } from '../services/recommendations.service';
import { executeTool, getToolDefinitions } from '../services/tool-router.service';
import { saveTranscript } from '../services/transcript.service';
import {
  getUnclearServiceEscalationResponse,
  shouldEscalateUnclearService,
} from '../services/voice-guard.service';
import type { Env } from '../types';

const twilioRouter = new Hono<HonoEnv>();

// ── Call history stored in CART KV (1-hour TTL per call) ─────────────────────
// Key: `call:{CallSid}`  Value: JSON array of { role, content }

type Turn = { role: 'user' | 'assistant'; content: string };

async function loadHistory(env: Env, callSid: string): Promise<Turn[]> {
  const raw = await env.CART.get(`call:${callSid}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(env: Env, callSid: string, history: Turn[]): Promise<void> {
  await env.CART.put(`call:${callSid}`, JSON.stringify(history), { expirationTtl: 3600 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAnthropic(apiKey: string) {
  return new Anthropic({ apiKey });
}

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
  const body      = await c.req.parseBody();
  const callSid   = body.CallSid as string | undefined;
  const sectorMetaInbound = await getSector(c.env, businessType);
  const storeName = sectorMetaInbound?.name ?? businessType;
  const token     = c.req.query('token');
  const turnUrl   = token ? `/twilio/turn?token=${encodeURIComponent(token)}` : '/twilio/turn';

  const greeting = `Welcome to ${storeName}. I'm Avery, your voice assistant. How can I help you today?`;

  // Seed KV with the greeting so turn 1 has context
  if (callSid) {
    await saveHistory(c.env, callSid, [{ role: 'assistant', content: greeting }]);
  }

  return c.text(twiml(greeting, turnUrl), 200, { 'Content-Type': 'text/xml' });
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
  const { businessType, account, sub } = session;
  const body    = await c.req.parseBody();
  const token   = c.req.query('token');
  const turnUrl = token ? `/twilio/turn?token=${encodeURIComponent(token)}` : '/twilio/turn';
  const callSid = (body.CallSid as string | undefined) ?? `web-${Date.now()}`;

  const utterance = ((body.SpeechResult as string) ?? '').trim();
  if (!utterance) {
    return c.text(twiml("I didn't catch that. Could you say that again?", turnUrl), 200,
      { 'Content-Type': 'text/xml' });
  }

  console.log(`[${callSid.slice(-8)}] ${businessType}: "${utterance.slice(0, 80)}"`);

  try {
    // ── Load full call history ──────────────────────────────────────────────
    const history = await loadHistory(c.env, callSid);

    // ── Build context ───────────────────────────────────────────────────────
    const [ordersResult, productsResult] = await Promise.allSettled([
      getOrders(c.env, sub, businessType),
      getProducts(c.env, businessType),
    ]);
    const recentOrders = ordersResult.status === 'fulfilled'
      ? ordersResult.value.slice(0, 3).map(o => `${o.productName} (${o.status})`) : [];
    const recs = productsResult.status === 'fulfilled'
      ? scoreProducts(productsResult.value, account.store_credit_cents).slice(0, 3).map(r => r.name) : [];

    const sectorMeta = await getSector(c.env, businessType);
    const bizName = sectorMeta?.name ?? businessType;

    if (shouldEscalateUnclearService(history, utterance)) {
      const spokenResponse = getUnclearServiceEscalationResponse(bizName);
      const updatedHistory: Turn[] = [
        ...history,
        { role: 'user', content: utterance },
        { role: 'assistant', content: spokenResponse },
      ];
      await saveHistory(c.env, callSid, updatedHistory);
      saveTranscript(c.env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
        .catch(err => console.error('transcript error', err.message));
      return c.text(twiml(spokenResponse, turnUrl), 200, { 'Content-Type': 'text/xml' });
    }

    const systemPrompt =
`You are Avery, the ${bizName} voice assistant on a live phone call.
Customer: ${account.tier} tier | $${(account.store_credit_cents / 100).toFixed(2)} store credit
Previous bookings: ${recentOrders.length ? recentOrders.join(', ') : 'none'}

RULES — follow exactly every single turn:
1. VOICE ONLY: max 2 sentences, no lists, no markdown, numbers spoken naturally.
2. NEVER guess prices, service names, or times — always call a tool first.
3. If the customer gives a specific service need, call search_services immediately.
4. If the customer is vague or unsure, ask one short service-clarifying question once. If they stay vague after that, stop asking and say: "I'm not sure which service fits best. Please call ${bizName} directly and we'll help you choose the right appointment."
5. If search_services returns matchType=ambiguous_intent, ask one short clarification once. If it returns matchType=no_match after a clarification attempt, escalate instead of rephrasing the same question.
6. BOOKING FLOW (one action per step, never skip, never repeat):
   Step A — customer mentions need → call search_services → say the top match name and price only.
   Step B — customer confirms interest → call check_availability(service_id=<id from search>) → offer 2-3 slots naturally ("I have Tuesday at 10 or Wednesday at 2 — which works?").
   Step C — customer picks a slot → call book_appointment(product_id, scheduled_at, payment_method=CREDIT_CARD) right away. Do NOT ask "shall I book?" — just book.
7. AFTER BOOKING: call get_upsells once, offer it briefly. Then wrap up.
8. NO LOOPS: If the customer already answered a question, never ask it again. Rephrasing the same service question counts as repeating it.
9. If asked about hours → get_business_hours. If asked about past bookings → list_bookings.
10. CANCEL FLOW: Customer says "cancel" → call cancel_booking(product_name=<what they mentioned>). COMPLETE status = confirmed appointment, NOT service delivered — it IS cancellable. Never tell the customer a booking can't be cancelled without calling cancel_booking first.`;

    // ── Assemble messages: full history + new utterance ─────────────────────
    const messages: Anthropic.MessageParam[] = [
      ...history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: utterance },
    ];

    const tools: Anthropic.Tool[] = getToolDefinitions(businessType, sectorMeta).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    // ── Agentic loop ─────────────────────────────────────────────────────────
    let spokenResponse = '';
    const anthropic = getAnthropic(c.env.ANTHROPIC_API_KEY);

    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        tools,
        messages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
          console.log(`[${callSid.slice(-8)}] tool: ${tb.name}`);
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, c.env, sectorMeta);
          return { type: 'tool_result' as const, tool_use_id: tb.id, content: JSON.stringify(result.data ?? { message: result.spoken_response }) };
        }));
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
      spokenResponse = textBlock?.text?.trim() ?? "Sorry, I had trouble with that.";
      break;
    }

    if (!spokenResponse) spokenResponse = "I'm having trouble right now. Please try again.";

    // ── Persist updated history ───────────────────────────────────────────────
    const updatedHistory: Turn[] = [
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: spokenResponse },
    ];
    await saveHistory(c.env, callSid, updatedHistory);

    // Fire-and-forget transcript
    saveTranscript(c.env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
      .catch(err => console.error('transcript error', err.message));

    return c.text(twiml(spokenResponse, turnUrl), 200, { 'Content-Type': 'text/xml' });

  } catch (err: any) {
    console.error(`[${callSid.slice(-8)}] error:`, err.message);
    return c.text(twiml("I'm having technical difficulties. Please try again.", turnUrl), 200,
      { 'Content-Type': 'text/xml' });
  }
});

export { twilioRouter };
