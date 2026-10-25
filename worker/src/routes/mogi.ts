import { Hono } from 'hono';
import type Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { withSession, withMogiSecret, sessionRateLimit } from '../middleware';
import { getSector } from '../services/sector.service';
import { getOrders } from '../services/order.service';
import { getSectorGreeting } from '../services/recommendations.service';
import { executeTool, getToolDefinitions } from '../services/tool-router.service';
import { emailTranscript } from '../services/email.service';
import { saveTranscript, getTranscripts } from '../services/transcript.service';
import {
  getUnclearServiceEscalationResponse,
  shouldEscalateUnclearService,
} from '../services/voice-guard.service';
import { agentModel, createAnthropic, HTTP_TIMEOUT_MS, MAX_TOOL_ROUNDS } from '../config';
import { CARTESIA_VERSION, DEFAULT_CARTESIA_MODEL, DEFAULT_VOICE_ID } from '../durable-objects/tts-cartesia';

const mogiRouter = new Hono<HonoEnv>();

type Turn = { role: 'user' | 'assistant'; content: string };

const MAX_UTTERANCE_CHARS = 1_000;
const MAX_HISTORY_TURNS = 40;
const MAX_TURN_CHARS = 4_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TTS_CHARS = 600;

// The browser holds the conversation and sends it back each turn, so treat
// it as untrusted input: bound its size and drop anything that isn't a plain
// user/assistant text turn.
export function sanitizeHistory(raw: unknown): Turn[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY_TURNS) return null;
  const out: Turn[] = [];
  for (const t of raw) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string') return null;
    if (t.content.length > MAX_TURN_CHARS) return null;
    out.push({ role: t.role, content: t.content });
  }
  return out;
}

// POST /mogi/transcribe — proxy audio to Deepgram REST (keeps API key server-side)
mogiRouter.post('/transcribe', withSession, sessionRateLimit('transcribe', 30, 60), async (c) => {
  const dgKey = c.env.DEEPGRAM_API_KEY;
  if (!dgKey) return c.json({ success: false, error: 'Deepgram not configured' }, 503);
  if (Number(c.req.header('content-length') ?? 0) > MAX_AUDIO_BYTES) {
    return c.json({ success: false, error: 'Audio too large' }, 413);
  }
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ success: false, error: 'Audio too large' }, 413);
  const contentType = c.req.header('content-type') ?? 'audio/webm';
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
    {
      method: 'POST', headers: { Authorization: `Token ${dgKey}`, 'Content-Type': contentType }, body: audio,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  if (!res.ok) return c.json({ success: false, error: `Deepgram ${res.status}` }, 502);
  const dg = await res.json() as any;
  const transcript = dg?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  return c.json({ success: true, data: { transcript } });
});

// POST /mogi/tts — proxy text to Cartesia so the API key never ships to the
// browser. Returns a WAV the admin UI's voice tester can play directly.
mogiRouter.post('/tts', withSession, sessionRateLimit('tts', 30, 60), async (c) => {
  const apiKey = c.env.CARTESIA_API_KEY;
  if (!apiKey) return c.json({ success: false, error: 'Cartesia not configured' }, 503);
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TTS_CHARS) {
    return c.json({ success: false, error: `text required (max ${MAX_TTS_CHARS} chars)` }, 400);
  }
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'Cartesia-Version': CARTESIA_VERSION, 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: c.env.CARTESIA_MODEL_ID ?? DEFAULT_CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: c.env.CARTESIA_VOICE_ID ?? DEFAULT_VOICE_ID },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    console.error('[tts proxy] cartesia', res.status, (await res.text().catch(() => '')).slice(0, 300));
    return c.json({ success: false, error: 'TTS failed' }, 502);
  }
  return new Response(res.body, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
});

// GET /mogi/tools
mogiRouter.get('/tools', withMogiSecret, withSession, (c) => {
  return c.json({ success: true, data: { tools: getToolDefinitions(c.get('session').businessType) } });
});

// GET /mogi/context — JWT only (browser calls this)
mogiRouter.get('/context', withSession, async (c) => {
  const { businessType, account } = c.get('session');
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
  const result = await executeTool(tool_name, args, c.get('session'), c.env, sm, undefined, undefined,
    (p) => c.executionCtx.waitUntil(p));
  return c.json({ success: true, data: result });
});

// POST /mogi/voice-turn — JWT only, 30 turns / 60 s per customer to cap Anthropic spend
mogiRouter.post('/voice-turn', withSession, sessionRateLimit('voice', 30, 60), async (c) => {
  const session = c.get('session');
  const { businessType, account, sub } = session;
  const body = await c.req.json().catch(() => ({}));

  const utterance = typeof body.utterance === 'string' ? body.utterance.trim() : '';
  if (!utterance || utterance.length > MAX_UTTERANCE_CHARS) {
    return c.json({ success: false, error: `utterance required (max ${MAX_UTTERANCE_CHARS} chars)` }, 400);
  }

  const rawHistory = sanitizeHistory(body.history);
  if (!rawHistory) {
    return c.json({ success: false, error: `history must be at most ${MAX_HISTORY_TURNS} user/assistant text turns` }, 400);
  }

  const recentOrders = await getOrders(c.env, sub, businessType)
    .then(orders => orders.slice(0, 3).map(o => `${o.productName} (${o.status})`))
    .catch(() => [] as string[]);

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
    c.executionCtx.waitUntil(saveTranscript(c.env, { customerIdHashed: sub, businessType, turns: updatedHistory })
      .catch(err => console.error('transcript save error', err.message)));
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
  const anthropic = createAnthropic(c.env);

  try {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const response = await anthropic.messages.create({
        model: agentModel(c.env),
        max_tokens: 400,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: systemPrompt,
        tools,
        messages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
          console.log(`voice-turn tool: ${tb.name}`);
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, c.env, sectorMeta, undefined, undefined,
            (p) => c.executionCtx.waitUntil(p));
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
    return c.json({ success: false, error: 'Assistant is temporarily unavailable', tool_calls: toolCallLog }, 502);
  }

  const updatedHistory = [
    ...rawHistory,
    { role: 'user' as const, content: utterance },
    { role: 'assistant' as const, content: spokenResponse },
  ];

  c.executionCtx.waitUntil(saveTranscript(c.env, { customerIdHashed: sub, businessType, turns: updatedHistory })
    .catch(err => console.error('transcript save error', err.message)));

  return c.json({ success: true, data: { spoken_response: spokenResponse, history: updatedHistory, tool_calls: toolCallLog } });
});

// GET /mogi/transcripts — JWT only
mogiRouter.get('/transcripts', withSession, async (c) => {
  const { sub, businessType } = c.get('session');
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10) || 10));
  const rows = await getTranscripts(c.env, sub, businessType, limit);
  return c.json({ success: true, data: { transcripts: rows } });
});

// POST /mogi/email-transcript — JWT only. Rate-limited hard: without a cap
// this is an open relay for sending arbitrary text to arbitrary addresses.
mogiRouter.post('/email-transcript', withSession, sessionRateLimit('email', 5, 3600), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const history = sanitizeHistory(body.history);
  if (!email || !history || !history.length) {
    return c.json({ success: false, error: 'email and history required' }, 400);
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ success: false, error: 'Invalid email address' }, 400);
  }
  try {
    const session = c.get('session');
    const emailSectorMeta = await getSector(c.env, session.businessType);
    await emailTranscript(email, history, session.businessType, c.env.RESEND_API_KEY, c.env.EMAIL_FROM, emailSectorMeta?.name);
    c.executionCtx.waitUntil(saveTranscript(c.env, { customerIdHashed: session.sub, businessType: session.businessType, turns: history, emailSentTo: email })
      .catch(err => console.error('transcript save error', err.message)));
    return c.json({ success: true, data: { message: `Transcript sent to ${email}` } });
  } catch (err: any) {
    console.error('email-transcript error', err.message);
    return c.json({ success: false, error: 'Failed to send email' }, 500);
  }
});

export { mogiRouter };
