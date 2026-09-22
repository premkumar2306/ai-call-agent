import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { withSession, withMogiSecret, sessionRateLimit } from '../middleware';
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

const mogiRouter = new Hono<HonoEnv>();

function getAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

// POST /mogi/transcribe — proxy audio to Deepgram REST (keeps API key server-side)
mogiRouter.post('/transcribe', withSession, async (c) => {
  const dgKey = c.env.DEEPGRAM_API_KEY;
  if (!dgKey) return c.json({ success: false, error: 'Deepgram not configured' }, 503);
  const audio = await c.req.arrayBuffer();
  const contentType = c.req.header('content-type') ?? 'audio/webm';
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
    { method: 'POST', headers: { Authorization: `Token ${dgKey}`, 'Content-Type': contentType }, body: audio }
  );
  if (!res.ok) return c.json({ success: false, error: `Deepgram ${res.status}` }, 502);
  const dg = await res.json() as any;
  const transcript = dg?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  return c.json({ success: true, data: { transcript } });
});

// GET /mogi/tools
mogiRouter.get('/tools', withMogiSecret, withSession, (c) => {
  return c.json({ success: true, data: { tools: getToolDefinitions(c.get('session').businessType) } });
});

// GET /mogi/context — JWT only (browser calls this)
mogiRouter.get('/context', withSession, async (c) => {
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

  return c.json({ success: true, data: { greeting } });
});

// POST /mogi/tool-call
mogiRouter.post('/tool-call', withMogiSecret, withSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { tool_name, arguments: args = {} } = body;
  if (!tool_name) return c.json({ success: false, error: 'tool_name required' }, 400);

  const sm = await getSector(c.env, c.get('session').businessType);
  const result = await executeTool(tool_name, args, c.get('session'), c.env, sm);
  return c.json({ success: true, data: result });
});

// POST /mogi/voice-turn — JWT only, 30 turns / 60 s per customer to cap Anthropic spend
mogiRouter.post('/voice-turn', withSession, sessionRateLimit('voice', 30, 60), async (c) => {
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

  const systemPrompt = `You are Mogi, a warm and friendly scheduling assistant for ${bizName}, on a live call. You sound like a real, helpful person — not a robot.
Customer: ${account.tier} tier | $${credit} store credit
Previous bookings: ${recentOrders.length > 0 ? recentOrders.join(', ') : 'none'}

TONE: Conversational and natural. Short, warm sentences. Never stiff or formal.
PRICES: Always use $ (dollars), never ₹ or other symbols. Say prices naturally ("it's $175" not "மதிப்பு $175").

RULES — follow exactly every single turn:
1. VOICE ONLY: max 2 sentences, no lists, no markdown.
2. NEVER guess prices, service names, or times — always call a tool first.
3. If the customer gives a specific service need, call search_services immediately.
4. If the customer is vague or unsure, ask one short service-clarifying question once. If they stay vague after that, say: "I'm not sure which fits best — please call ${bizName} directly and we'll sort it out!"
5. If search_services returns matchType=ambiguous_intent, ask one short clarification once. If it returns matchType=no_match after a clarification attempt, escalate warmly instead of repeating the same question.
6. BOOKING FLOW (one step at a time, never skip):
   Step A — customer mentions need → call search_services → share the top match name and price warmly ("Great news — we have X for $Y!").
   Step B — customer says yes/interested → call check_availability(service_id=<id from search>) → offer 2–3 slots naturally ("I've got Tuesday at 10 or Wednesday at 2 — which works for you?").
   Step C — customer picks a slot → call book_appointment(product_id, scheduled_at, payment_method=CREDIT_CARD) immediately. Do NOT ask "shall I book?" — just book it.
7. AFTER BOOKING: call get_upsells once, offer it casually. Then wrap up warmly.
8. NO LOOPS: Never repeat a question the customer already answered. Don't rephrase the same service question.
9. Hours → get_business_hours. Past bookings → list_bookings.
10. CANCEL: "cancel" → call cancel_booking(product_name=<what they mentioned>). COMPLETE status = confirmed appointment, not delivered — it IS cancellable. Never say it can't be cancelled without calling cancel_booking first.`;

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

  saveTranscript(c.env, { customerIdHashed: sub, businessType, turns: updatedHistory })
    .catch(err => console.error('transcript save error', err.message));

  return c.json({ success: true, data: { spoken_response: spokenResponse, history: updatedHistory, tool_calls: toolCallLog } });
});

// GET /mogi/transcripts — JWT only
mogiRouter.get('/transcripts', withSession, async (c) => {
  const { sub, businessType } = c.get('session');
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const rows = await getTranscripts(c.env, sub, businessType, limit);
  return c.json({ success: true, data: { transcripts: rows } });
});

// POST /mogi/email-transcript — JWT only
mogiRouter.post('/email-transcript', withSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, history } = body;
  if (!email || !Array.isArray(history)) {
    return c.json({ success: false, error: 'email and history required' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ success: false, error: 'Invalid email address' }, 400);
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

export { mogiRouter };
