import Anthropic from '@anthropic-ai/sdk';
import type { Env, SessionPayload } from '../types';
import { getSector } from './sector.service';
import { getProducts } from './catalog.service';
import { getOrders } from './order.service';
import { scoreProducts } from './recommendations.service';
import { executeTool, getToolDefinitions } from './tool-router.service';
import { saveTranscript } from './transcript.service';
import {
  getUnclearServiceEscalationResponse,
  shouldEscalateUnclearService,
} from './voice-guard.service';

// ── Call history stored in CART KV (1-hour TTL per call) ─────────────────────
// Key: `call:{CallSid}`  Value: JSON array of { role, content }

export type Turn = { role: 'user' | 'assistant'; content: string };

export async function loadHistory(env: Env, callSid: string): Promise<Turn[]> {
  const raw = await env.CART.get(`call:${callSid}`);
  return raw ? JSON.parse(raw) : [];
}

export async function saveHistory(env: Env, callSid: string, history: Turn[]): Promise<void> {
  await env.CART.put(`call:${callSid}`, JSON.stringify(history), { expirationTtl: 3600 });
}

function getAnthropic(apiKey: string) {
  return new Anthropic({ apiKey });
}

export interface TurnResult {
  spokenResponse: string;
  history: Turn[];
}

export async function runTurn(
  env: Env,
  session: SessionPayload,
  callSid: string,
  utterance: string,
): Promise<TurnResult> {
  const { businessType, account, sub } = session;

  console.log(`[${callSid.slice(-8)}] ${businessType}: "${utterance.slice(0, 80)}"`);

  // ── Load full call history ──────────────────────────────────────────────
  const history = await loadHistory(env, callSid);

  // ── Build context ─────────────────────────────────────────────────────────
  const [ordersResult, productsResult] = businessType === 'health_nav'
    ? [{ status: 'fulfilled' as const, value: [] }, { status: 'fulfilled' as const, value: [] }]
    : await Promise.allSettled([
        getOrders(env, sub, businessType),
        getProducts(env, businessType),
      ]);
  const recentOrders = ordersResult.status === 'fulfilled'
    ? ordersResult.value.slice(0, 3).map((o: any) => `${o.productName} (${o.status})`) : [];
  const recs = productsResult.status === 'fulfilled'
    ? scoreProducts(productsResult.value as any[], account.store_credit_cents).slice(0, 3).map((r: any) => r.name) : [];

  const sectorMeta = await getSector(env, businessType);
  const bizName = sectorMeta?.name ?? businessType;

  if (shouldEscalateUnclearService(history, utterance)) {
    const spokenResponse = getUnclearServiceEscalationResponse(bizName);
    const updatedHistory: Turn[] = [
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: spokenResponse },
    ];
    await saveHistory(env, callSid, updatedHistory);
    saveTranscript(env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
      .catch(err => console.error('transcript error', err.message));
    return { spokenResponse, history: updatedHistory };
  }

  const systemPrompt = businessType === 'health_nav'
    ? `You are Mogi, a health plan member services specialist for ${bizName}, on a live phone call. You are empathetic, knowledgeable about insurance, and speak like a real person — warm and clear, never robotic.

VOICE RULES:
1. Max 2 sentences per turn. Natural speech, no lists, no markdown.
2. Never guess coverage, claim outcomes, or auth decisions — call search_services first.
3. For urgent clinical or emergency concerns: skip pleasantries, act immediately.
4. To discuss specific coverage details, first confirm the member's date of birth or member ID.`
    : `You are Mogi, a warm and friendly scheduling assistant for ${bizName}, on a live phone call. You sound like a real, helpful person — not a robot.
Customer: ${account.tier} tier | $${(account.store_credit_cents / 100).toFixed(2)} store credit
Previous bookings: ${recentOrders.length ? recentOrders.join(', ') : 'none'}

TONE: Conversational and natural. Short, warm sentences. Never stiff or formal.
PRICES: Always use $ (dollars), never ₹ or other symbols. Say prices naturally ("it's $175").

RULES — follow exactly every single turn:
1. VOICE ONLY: max 2 sentences, no lists, no markdown.
2. NEVER guess prices, service names, or times — always call a tool first.
3. If the customer gives a specific service need, call search_services immediately.
4. If the customer is vague or unsure, ask one short service-clarifying question once. If they stay vague after that, say: "I'm not sure which fits best — please call ${bizName} directly and we'll sort it out!"
5. If search_services returns matchType=ambiguous_intent, ask one short clarification once. If it returns matchType=no_match after a clarification attempt, escalate warmly instead of repeating.
6. BOOKING FLOW (one step at a time, never skip):
   Step A — customer mentions need → call search_services → share the top match name and price warmly ("Great news — we have X for $Y!").
   Step B — customer says yes/interested → call check_availability(service_id=<id from search>) → offer 2–3 slots naturally ("I've got Tuesday at 10 or Wednesday at 2 — which works for you?").
   Step C — customer picks a slot → call book_appointment(product_id, scheduled_at, payment_method=CREDIT_CARD) immediately. Do NOT ask "shall I book?" — just book it.
7. AFTER BOOKING: call get_upsells once, offer it casually. Then wrap up warmly.
8. NO LOOPS: Never repeat a question the customer already answered.
9. Hours → get_business_hours. Past bookings → list_bookings.
10. CANCEL: "cancel" → call cancel_booking(product_name=<what they mentioned>). COMPLETE = confirmed appointment, not delivered — it IS cancellable. Never say it can't be cancelled without calling cancel_booking first.`;

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
  const anthropic = getAnthropic(env.ANTHROPIC_API_KEY);

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
        const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, env, sectorMeta);
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
  await saveHistory(env, callSid, updatedHistory);

  // Fire-and-forget transcript
  saveTranscript(env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
    .catch(err => console.error('transcript error', err.message));

  return { spokenResponse, history: updatedHistory };
}
