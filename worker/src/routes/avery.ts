import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { withSession, withAverySecret } from '../middleware';
import { getSector } from '../services/sector.service';
import { getProducts } from '../services/catalog.service';
import { getOrders } from '../services/order.service';
import { scoreProducts, getSectorGreeting } from '../services/recommendations.service';
import { executeTool, getToolDefinitions } from '../services/tool-router.service';
import { emailTranscript } from '../services/email.service';
import { saveTranscript, getTranscripts } from '../services/transcript.service';
import {
  getUnclearServiceEscalationResponse,
  shouldEscalateUnclearService,
} from '../services/voice-guard.service';

const averyRouter = new Hono<HonoEnv>();

function getAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

// GET /avery/tools
averyRouter.get('/tools', withAverySecret, withSession, (c) => {
  return c.json({ success: true, data: { tools: getToolDefinitions(c.get('session').businessType) } });
});

// GET /avery/context — JWT only (browser calls this)
averyRouter.get('/context', withSession, async (c) => {
  const { businessType, account, sub } = c.get('session');

  const [ordersResult, productsResult] = await Promise.allSettled([
    getOrders(c.env, sub, businessType),
    getProducts(c.env, businessType),
  ]);

  const recentOrders = ordersResult.status === 'fulfilled'
    ? ordersResult.value.slice(0, 3).map(o => `${o.productName} (${o.status})`)
    : [];
  const recs = productsResult.status === 'fulfilled'
    ? scoreProducts(productsResult.value, account.store_credit_cents).slice(0, 3)
        .map(r => `${r.name} — ${r.reason}`)
    : [];

  const sectorMeta = await getSector(c.env, businessType);
  const greeting = getSectorGreeting(businessType, account.store_credit_cents, account.tier, sectorMeta ?? undefined);
  const credit = (account.store_credit_cents / 100).toFixed(2);

  const bizName = sectorMeta?.name ?? businessType;
  const systemPrompt = `You are Avery, the ${bizName} voice assistant on a live call.
Customer: ${account.tier} tier | $${credit} store credit
Previous bookings: ${recentOrders.length > 0 ? recentOrders.join(', ') : 'none'}

RULES — follow exactly every single turn:
1. VOICE ONLY: max 2 sentences, no lists, no markdown, numbers spoken naturally.
2. NEVER guess prices, service names, or times — always call a tool first.
3. INTENT → ACTION: When the customer mentions any service or need, call search_services immediately. Do NOT ask a clarifying question first.
4. BOOKING FLOW (one action per step, never skip, never repeat):
   Step A — customer mentions need → call search_services → say the top match name and price only.
   Step B — customer confirms interest → call check_availability(service_id=<id from search>) → offer 2-3 slots naturally ("I have Tuesday at 10 or Wednesday at 2 — which works?").
   Step C — customer picks a slot → call book_appointment(product_id, scheduled_at, payment_method=CREDIT_CARD) right away. Do NOT ask "shall I book?" — just book.
5. AFTER BOOKING: call get_upsells once, offer it briefly. Then wrap up.
6. NO LOOPS: If the customer already answered a question, never ask it again. Check history.
7. If asked about hours → get_business_hours. If asked about past bookings → list_bookings.
8. CANCEL FLOW: Customer says "cancel" → call cancel_booking(product_name=<what they mentioned>). COMPLETE status = confirmed appointment, NOT service delivered — it IS cancellable. Never tell the customer a booking can't be cancelled without calling cancel_booking first.`;

  return c.json({ success: true, data: { system_prompt: systemPrompt, greeting } });
});

// POST /avery/tool-call
averyRouter.post('/tool-call', withAverySecret, withSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { tool_name, arguments: args = {} } = body;
  if (!tool_name) return c.json({ success: false, error: 'tool_name required' }, 400);

  const sm = await getSector(c.env, c.get('session').businessType);
  const result = await executeTool(tool_name, args, c.get('session'), c.env, sm);
  return c.json({ success: true, data: result });
});

// POST /avery/voice-turn — JWT only (browser calls this)
averyRouter.post('/voice-turn', withSession, async (c) => {
  const session = c.get('session');
  const { businessType, account, sub } = session;
  const body = await c.req.json().catch(() => ({}));

  const utterance: string = body.utterance ?? '';
  if (!utterance.trim()) {
    return c.json({ success: false, error: 'utterance required' }, 400);
  }

  const rawHistory: Array<{ role: 'user' | 'assistant'; content: string }> = body.history ?? [];

  const [ordersResult, productsResult] = await Promise.allSettled([
    getOrders(c.env, sub, businessType),
    getProducts(c.env, businessType),
  ]);

  const recentOrders = ordersResult.status === 'fulfilled'
    ? ordersResult.value.slice(0, 3).map(o => `${o.productName} (${o.status})`)
    : [];
  const recs = productsResult.status === 'fulfilled'
    ? scoreProducts(productsResult.value, account.store_credit_cents).slice(0, 3).map(r => `${r.name} — ${r.reason}`)
    : [];

  const sectorMeta = await getSector(c.env, businessType);
  const credit = (account.store_credit_cents / 100).toFixed(2);
  const bizName = sectorMeta?.name ?? businessType;

  if (shouldEscalateUnclearService(rawHistory, utterance)) {
    const spokenResponse = getUnclearServiceEscalationResponse(bizName);
    const updatedHistory = [
      ...rawHistory,
      { role: 'user' as const, content: utterance },
      { role: 'assistant' as const, content: spokenResponse },
    ];
    saveTranscript(c.env, { customerIdHashed: sub, businessType, turns: updatedHistory })
      .catch(err => console.error('transcript save error', err.message));
    return c.json({ success: true, data: { spoken_response: spokenResponse, history: updatedHistory, tool_calls: [] } });
  }

  const systemPrompt = `You are Avery, the ${bizName} voice assistant on a live call.
Customer: ${account.tier} tier | $${credit} store credit
Previous bookings: ${recentOrders.length > 0 ? recentOrders.join(', ') : 'none'}

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

  const tools: Anthropic.Tool[] = getToolDefinitions(businessType, sectorMeta).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));

  const messages: Anthropic.MessageParam[] = [
    ...rawHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: utterance },
  ];

  let spokenResponse = '';
  const toolCallLog: Array<{ name: string; input: unknown; result: unknown }> = [];
  const anthropic = getAnthropic(c.env.ANTHROPIC_API_KEY);

  try {
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
          console.log(`voice-turn tool: ${tb.name}`);
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, c.env, sectorMeta);
          toolCallLog.push({ name: tb.name, input: tb.input, result: result.data ?? { message: result.spoken_response } });
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
  } catch (err: any) {
    console.error('voice-turn anthropic error:', err.message);
    return c.json({ success: false, error: err.message ?? 'unknown error', tool_calls: toolCallLog }, 500);
  }

  const updatedHistory = [
    ...rawHistory,
    { role: 'user' as const, content: utterance },
    { role: 'assistant' as const, content: spokenResponse },
  ];

  // Fire-and-forget transcript save
  saveTranscript(c.env, { customerIdHashed: sub, businessType, turns: updatedHistory })
    .catch(err => console.error('transcript save error', err.message));

  return c.json({ success: true, data: { spoken_response: spokenResponse, history: updatedHistory, tool_calls: toolCallLog } });
});

// GET /avery/transcripts — JWT only
averyRouter.get('/transcripts', withSession, async (c) => {
  const { sub, businessType } = c.get('session');
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const rows = await getTranscripts(c.env, sub, businessType, limit);
  return c.json({ success: true, data: { transcripts: rows } });
});

// POST /avery/email-transcript — JWT only
averyRouter.post('/email-transcript', withSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, history } = body;
  if (!email || !Array.isArray(history)) {
    return c.json({ success: false, error: 'email and history required' }, 400);
  }
  try {
    const session = c.get('session');
    const emailSectorMeta = await getSector(c.env, session.businessType);
    await emailTranscript(email, history, session.businessType, c.env.RESEND_API_KEY, c.env.EMAIL_FROM, emailSectorMeta?.name);
    saveTranscript(c.env, { customerIdHashed: session.sub, businessType: session.businessType, turns: history, emailSentTo: email })
      .catch(err => console.error('transcript save error', err.message));
    return c.json({ success: true, data: { message: `Transcript sent to ${email}` } });
  } catch (err: any) {
    console.error('email-transcript error', err.message);
    return c.json({ success: false, error: 'Failed to send email' }, 500);
  }
});

export { averyRouter };
