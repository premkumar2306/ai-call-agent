import Anthropic from '@anthropic-ai/sdk';
import type { Env, SessionPayload } from '../types';
import { getSector } from './sector.service';
import { getProducts } from './catalog.service';
import { getOrders } from './order.service';
import { scoreProducts } from './recommendations.service';
import { executeTool, getToolDefinitions } from './tool-router.service';
import { saveTranscript } from './transcript.service';
import type { CallCache } from './call-context';
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

// Called with each sentence-sized chunk of the model's text as soon as it's
// ready (before the full turn — including any tool round-trips — completes),
// so the caller (CallRelay) can start TTS well before the whole answer exists.
// Awaited so chunk delivery order is preserved 1:1 with speech order.
export type OnChunk = (chunk: string) => void | Promise<void>;

// Pops the next complete sentence off the front of `buffer` (ending in
// . ! or ? followed by whitespace or end-of-string). Returns null if the
// buffer doesn't yet contain a full sentence.
function popSentence(buffer: string): { chunk: string; rest: string } | null {
  const m = buffer.match(/[.!?]+(\s+|$)/);
  if (!m || m.index === undefined) return null;
  const end = m.index + m[0].length;
  const chunk = buffer.slice(0, end).trim();
  const rest = buffer.slice(end);
  if (!chunk) return rest === buffer ? null : { chunk: '', rest };
  return { chunk, rest };
}

function extractCompleteSentences(buffer: string): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let rest = buffer;
  while (true) {
    const popped = popSentence(rest);
    if (!popped) break;
    if (popped.chunk) chunks.push(popped.chunk);
    rest = popped.rest;
  }
  return { chunks, rest };
}

export async function runTurn(
  env: Env,
  session: SessionPayload,
  callSid: string,
  utterance: string,
  onChunk?: OnChunk,
  cache?: CallCache,
): Promise<TurnResult> {
  const { businessType, account, sub } = session;
  const tag = callSid.slice(-8);
  const t0 = Date.now();
  const lap = (label: string) => console.log(`[${tag}] ⏱ ${label}: ${Date.now() - t0}ms`);

  console.log(`[${tag}] ${businessType}: "${utterance.slice(0, 80)}"`);

  // ── Load call history ───────────────────────────────────────────────────
  // When a call-lifetime `cache` is supplied (the CallRelay Durable Object),
  // history lives in memory for the whole call and this is a plain array
  // read. Callers without one (e.g. the stateless /twilio/turn TwiML route,
  // which gets one HTTP request per turn with no persistent memory) fall
  // back to the KV-backed load, same as before.
  const history = cache ? cache.history : await loadHistory(env, callSid);
  lap('loadHistory');

  // ── Build context — orders, products, sector metadata ───────────────────
  // Independent of each other and of history, so whatever isn't already
  // cached for this call gets fetched in one wave instead of three
  // sequential ones. health_nav has no orders/products concept.
  const needOrders = businessType !== 'health_nav' && !(cache?.ordersLoaded);
  const needProducts = businessType !== 'health_nav' && !cache?.productsAll;
  const needSector = !cache?.sectorMeta;

  const [ordersResult, productsResult, sectorResult] = await Promise.allSettled([
    needOrders ? getOrders(env, sub, businessType) : Promise.resolve(cache?.orders ?? []),
    needProducts ? getProducts(env, businessType) : Promise.resolve(cache?.productsAll ?? []),
    needSector ? getSector(env, businessType) : Promise.resolve(cache?.sectorMeta ?? null),
  ]);
  lap(`orders+products+sector (cached: ${[
    !needOrders && 'orders', !needProducts && 'products', !needSector && 'sector',
  ].filter(Boolean).join(',') || 'none'})`);

  if (cache) {
    if (needOrders && ordersResult.status === 'fulfilled') { cache.orders = ordersResult.value as any; cache.ordersLoaded = true; }
    if (needProducts && productsResult.status === 'fulfilled') cache.productsAll = productsResult.value as any;
    if (needSector && sectorResult.status === 'fulfilled') cache.sectorMeta = sectorResult.value as any;
  }

  const recentOrders = ordersResult.status === 'fulfilled'
    ? (ordersResult.value as any[]).slice(0, 3).map((o: any) => `${o.productName} (${o.status})`) : [];
  const recs = productsResult.status === 'fulfilled'
    ? scoreProducts(productsResult.value as any[], account.store_credit_cents).slice(0, 3).map((r: any) => r.name) : [];

  const sectorMeta = sectorResult.status === 'fulfilled' && sectorResult.value
    ? (sectorResult.value as any)
    : (cache?.sectorMeta ?? null);
  const bizName = sectorMeta?.name ?? businessType;

  if (shouldEscalateUnclearService(history, utterance)) {
    const spokenResponse = getUnclearServiceEscalationResponse(bizName);
    if (onChunk) await onChunk(spokenResponse);
    const updatedHistory: Turn[] = [
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: spokenResponse },
    ];
    if (cache) cache.history = updatedHistory;
    // Fire-and-forget: the answer is already spoken, this is durability-only.
    saveHistory(env, callSid, updatedHistory).catch(err => console.error('saveHistory error', err.message));
    saveTranscript(env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
      .catch(err => console.error('transcript error', err.message));
    return { spokenResponse, history: updatedHistory };
  }

  // System prompt is split so the prompt-cacheable, per-turn-invariant rules
  // (which also don't change across calls to the same business) sit in a
  // separate block from the volatile per-customer facts (tier, store
  // credit, recent bookings) that do change turn to turn. A cache_control
  // breakpoint on the stable block lets Anthropic reuse it turn-to-turn
  // (and call-to-call) instead of reprocessing it every time. Check
  // `usage.cache_read_input_tokens` in the logs below to confirm this is
  // actually landing — if it's always 0 the prompt may be under Haiku's
  // minimum cacheable length and this isn't buying anything.
  const stableRules = businessType === 'health_nav'
    ? `You are Mogi, a health plan member services specialist for ${bizName}, on a live phone call. You are empathetic, knowledgeable about insurance, and speak like a real person — warm and clear, never robotic.

VOICE RULES:
1. Max 2 sentences per turn. Natural speech, no lists, no markdown.
2. Never guess coverage, claim outcomes, or auth decisions — call search_services first.
3. For urgent clinical or emergency concerns: skip pleasantries, act immediately.
4. To discuss specific coverage details, first confirm the member's date of birth or member ID.`
    : `You are Mogi, a warm and friendly scheduling assistant for ${bizName}, on a live phone call. You sound like a real, helpful person — not a robot.

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
10. CANCEL: "cancel" → call cancel_booking(product_name=<what they mentioned>). COMPLETE = confirmed appointment, not delivered — it IS cancellable. Never say it can't be cancelled without calling cancel_booking first.
11. A tool result's JSON may include a "_spoken_hint" field — a ready-made sentence for that result. Prefer lightly paraphrasing it over composing from scratch, unless the conversation needs something different.`;

  const volatileFacts = businessType === 'health_nav'
    ? ''
    : `Customer: ${account.tier} tier | $${(account.store_credit_cents / 100).toFixed(2)} store credit
Previous bookings: ${recentOrders.length ? recentOrders.join(', ') : 'none'}`;

  const systemPrompt: Anthropic.TextBlockParam[] = [
    { type: 'text', text: stableRules, cache_control: { type: 'ephemeral' } },
    ...(volatileFacts ? [{ type: 'text' as const, text: volatileFacts }] : []),
  ];

  // ── Assemble messages: full history + new utterance ─────────────────────
  const messages: Anthropic.MessageParam[] = [
    ...history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
    { role: 'user', content: utterance },
  ];

  // Tool defs are byte-identical for every turn of a call (same business,
  // same sectorMeta) — cache them on the call instead of rebuilding ~11
  // template-literal objects every turn, and mark the last one as a cache
  // breakpoint so Anthropic can reuse the `tools` prefix across turns too.
  let tools = cache?.toolDefs;
  if (!tools) {
    tools = getToolDefinitions(businessType, sectorMeta).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));
    if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
    if (cache) cache.toolDefs = tools;
  }

  // ── Agentic loop ─────────────────────────────────────────────────────────
  let spokenResponse = '';
  const anthropic = getAnthropic(env.ANTHROPIC_API_KEY);

  for (let i = 0; i < 5; i++) {
    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      tools,
      messages,
    });

    let buffer = '';
    let firstTokenLapped = false;
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        if (!firstTokenLapped) { lap(`anthropic#${i} first-token`); firstTokenLapped = true; }
        buffer += event.delta.text;
        const { chunks, rest } = extractCompleteSentences(buffer);
        buffer = rest;
        for (const chunk of chunks) {
          spokenResponse = spokenResponse ? `${spokenResponse} ${chunk}` : chunk;
          if (onChunk) await onChunk(chunk);
        }
      }
    }

    const response = await stream.finalMessage();
    lap(`anthropic#${i} (${response.stop_reason})`);
    const usage = response.usage as any;
    if (usage) {
      lap(`anthropic#${i} usage (in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0})`);
    }

    // Flush any trailing text that didn't end on sentence punctuation
    // (e.g. the model's chatter right before a tool_use block).
    const trailing = buffer.trim();
    if (trailing) {
      spokenResponse = spokenResponse ? `${spokenResponse} ${trailing}` : trailing;
      if (onChunk) await onChunk(trailing);
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
      const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
        console.log(`[${tag}] tool: ${tb.name}`);
        const toolT0 = Date.now();
        const result = await executeTool(
          tb.name,
          tb.input as Record<string, unknown>,
          session,
          env,
          sectorMeta,
          cache,
          (label) => console.log(`[${tag}] ⏱ tool:${tb.name}:${label}: ${Date.now() - toolT0}ms`),
        );
        lap(`tool:${tb.name} total`);
        // §3a — feed the tool's own hand-written voice-shaped response back
        // to the model as a phrasing hint (see stableRules rule 11) instead
        // of discarding it. Doesn't save a round trip, but gives call #2 a
        // ready-made sentence to paraphrase rather than compose from
        // scratch, which should make it shorter and faster.
        const payload = (result.data ?? { message: result.spoken_response }) as Record<string, unknown>;
        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify({ ...payload, _spoken_hint: result.spoken_response }),
        };
        return toolResult;
      }));
      lap(`tools#${i} (${toolBlocks.map(t => t.name).join(',')})`);
      messages.push({ role: 'assistant', content: response.content });
      // Cache breakpoint after the tool results: this turn's messages array
      // (history + utterance + assistant tool_use + tool_result) is the
      // exact prefix call #2 sees, so marking it lets call #2 reuse
      // everything call #1 already processed instead of reprocessing it.
      if (toolResults.length) toolResults[toolResults.length - 1] = {
        ...toolResults[toolResults.length - 1],
        cache_control: { type: 'ephemeral' },
      };
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }
  lap('runTurn total');

  if (!spokenResponse) {
    spokenResponse = "I'm having trouble right now. Please try again.";
    if (onChunk) await onChunk(spokenResponse);
  }

  // ── Persist updated history ───────────────────────────────────────────────
  const updatedHistory: Turn[] = [
    ...history,
    { role: 'user', content: utterance },
    { role: 'assistant', content: spokenResponse },
  ];
  if (cache) cache.history = updatedHistory;
  // Fire-and-forget: the answer is already spoken by the time this runs
  // (onChunk delivery happens above), so awaiting it only delays the DO for
  // no benefit to the caller. KV write-behind is durability-only — the
  // in-memory `cache.history` above is what subsequent turns actually read.
  saveHistory(env, callSid, updatedHistory).catch(err => console.error('saveHistory error', err.message));

  // Fire-and-forget transcript
  saveTranscript(env, { callSid, customerIdHashed: sub, businessType, turns: updatedHistory })
    .catch(err => console.error('transcript error', err.message));

  return { spokenResponse, history: updatedHistory };
}
