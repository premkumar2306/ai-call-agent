import Anthropic from '@anthropic-ai/sdk';
import type { Env, SessionPayload } from '../types';
import { createAnthropic, MAX_TOOL_ROUNDS, VOICE_MODEL_TIMEOUT_MS, voiceModel } from '../config';
import { getSector } from './sector.service';
import { getProducts } from './catalog.service';
import { getOrders } from './order.service';
import { executeTool, getToolDefinitions, formatSlotLabel, type ToolResult } from './tool-router.service';
import { saveTranscript } from './transcript.service';
import { buildBusinessProfile, describeLocalNow, FULL_CATALOG_MAX } from './business-profile';
import type { CallCache } from './call-context';
import type { Order, Product, SectorMeta } from '../types';

// ── Call history stored in CART KV (1-hour TTL per call) ─────────────────────
// Two views of the same conversation:
//   `call:{CallSid}`     — Turn[]: plain user/assistant text. The transcript,
//                          and what /twilio/status classifies at call end.
//   `callmsgs:{CallSid}` — the model's own message list, tool_use and
//                          tool_result blocks included. This is what the
//                          next turn sends, so the model still knows the
//                          service id it found and the exact slot datetimes
//                          it offered. Keeping only the spoken text (as this
//                          used to) made it re-search and re-ask every turn.

export type Turn = { role: 'user' | 'assistant'; content: string };

export async function loadHistory(env: Env, callSid: string): Promise<Turn[]> {
  const raw = await env.CART.get(`call:${callSid}`);
  return raw ? JSON.parse(raw) : [];
}

export async function saveHistory(env: Env, callSid: string, history: Turn[]): Promise<void> {
  await env.CART.put(`call:${callSid}`, JSON.stringify(history), { expirationTtl: 3600 });
}

async function loadMessages(env: Env, callSid: string): Promise<Anthropic.MessageParam[]> {
  const raw = await env.CART.get(`callmsgs:${callSid}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveMessages(env: Env, callSid: string, messages: Anthropic.MessageParam[]): Promise<void> {
  await env.CART.put(`callmsgs:${callSid}`, JSON.stringify(messages), { expirationTtl: 3600 });
}

// Schedules durability-only work (history/transcript writes) that must not
// block the spoken reply. HTTP routes pass ctx.waitUntil so the isolate isn't
// torn down before the write lands; the CallRelay DO lives for the whole call
// so a plain floating promise is fine there.
export type Background = (p: Promise<unknown>) => void;
const floating: Background = (p) => { void p; };

export interface TurnResult {
  spokenResponse: string;
  history: Turn[];
  /** The turn was cut short by `signal` (caller barge-in). */
  interrupted: boolean;
  /**
   * False only when an interrupted turn left nothing worth remembering — no
   * audio heard, no tool run. The caller should then fold this utterance
   * into the next one rather than drop it.
   */
  committed: boolean;
}

// Called with each chunk of the model's text as soon as it's ready (before
// the full turn — including any tool round-trips — completes), so the caller
// (CallRelay) can start TTS well before the whole answer exists.
//
// NOT awaited. Ordering is the callee's job: CallRelay chains chunks onto a
// single promise so playback stays strictly sequential. Awaiting here used to
// mean the Anthropic stream stopped being read until every queued TTS call
// had finished, which on a tool turn delayed issuing the tool call itself
// behind synthesis of the model's preamble text.
export type OnChunk = (chunk: string) => void | Promise<void>;

// Minimum characters before the *first* chunk of a turn may be flushed on a
// clause boundary rather than a sentence end. Short enough to beat the
// sentence wait, long enough that TTS still gets a speakable phrase —
// "Great news," on its own sounds clipped.
const FIRST_CHUNK_MIN_CHARS = 25;

// Hard ceiling on how long the first chunk may sit unflushed waiting for
// punctuation. Past this, break at the last word boundary. This is what
// bounds worst-case time-to-first-audio on a long run-on opening sentence —
// the exact case where waiting for a period hurts most.
const FIRST_CHUNK_MAX_CHARS = 90;

// Pops the next complete sentence off the front of `buffer` (ending in
// . ! or ? followed by whitespace or end-of-string). Returns null if the
// buffer doesn't yet contain a full sentence.
export function popSentence(buffer: string): { chunk: string; rest: string } | null {
  const m = buffer.match(/[.!?]+(\s+|$)/);
  if (!m || m.index === undefined) return null;
  const end = m.index + m[0].length;
  const chunk = buffer.slice(0, end).trim();
  const rest = buffer.slice(end);
  if (!chunk) return rest === buffer ? null : { chunk: '', rest };
  return { chunk, rest };
}

// The first chunk of a turn is the one the caller is actually waiting on, so
// it gets flushed on a clause boundary (comma, semicolon, colon, dash) once
// there's enough text to be worth speaking — rather than waiting for terminal
// punctuation like every later chunk does. Prosody on a clause is slightly
// flatter than on a whole sentence, which is why this is first-chunk-only:
// by the time chunk 2 is needed, chunk 1 is already playing and covering it.
export function popFirstChunk(buffer: string): { chunk: string; rest: string } | null {
  // A finished sentence is always the best unit to speak — take it if we have one.
  const sentence = popSentence(buffer);
  if (sentence) return sentence;
  if (buffer.length < FIRST_CHUNK_MIN_CHARS) return null;

  // Otherwise the earliest clause boundary that yields a long-enough phrase.
  const re = /[,;:]\s+|\s+[—–-]\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const end = m.index + m[0].length;
    if (end >= FIRST_CHUNK_MIN_CHARS) {
      const chunk = buffer.slice(0, end).trim();
      if (chunk) return { chunk, rest: buffer.slice(end) };
    }
  }

  // No punctuation in sight and the caller is still waiting — break at the
  // last word boundary rather than let time-to-first-audio run unbounded.
  if (buffer.length >= FIRST_CHUNK_MAX_CHARS) {
    const cut = buffer.lastIndexOf(' ', FIRST_CHUNK_MAX_CHARS);
    if (cut >= FIRST_CHUNK_MIN_CHARS) {
      const chunk = buffer.slice(0, cut).trim();
      if (chunk) return { chunk, rest: buffer.slice(cut + 1) };
    }
  }
  return null;
}

// Tools whose hand-written `spoken_response` is a complete, natural reply on
// its own. When one of these is the only tool called in a round, we speak it
// directly and end the turn instead of making a second Claude call purely to
// paraphrase it — which is the single largest cost on a tool turn (one full
// extra round trip, TTFT included).
//
// Scoped deliberately narrowly: each case below also checks the tool actually
// produced a usable result, because the escalation/clarification rules in the
// system prompt genuinely need the model when a search is ambiguous or a
// lookup came back empty. Set VOICE_DIRECT_TOOL_REPLY=0 to disable and fall
// back to always round-tripping.
export function canSpeakToolResultDirectly(toolName: string, result: ToolResult): boolean {
  if (!result.success || !result.spoken_response) return false;
  const d = result.data as any;
  switch (toolName) {
    case 'get_business_hours':
      return true;
    case 'check_availability':
      return Array.isArray(d?.offered) && d.offered.length > 0;
    case 'search_services':
    case 'search_products':
      return d?.matchType === 'match';
    default:
      return false;
  }
}

export function extractCompleteSentences(buffer: string): { chunks: string[]; rest: string } {
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

// What the phone agent may call. The profile in the system prompt answers
// every "what / how much / where / when are you open" question, so the
// voice toolset is only live data. Fewer tools also means fewer wrong picks
// from a small fast model.
const VOICE_TOOLS = new Set([
  'search_services', 'get_service_detail', 'check_availability', 'book_appointment',
  'list_bookings', 'get_booking_status', 'cancel_booking',
]);

/** Tool definitions for the agent surfaces, last one marked as a cache breakpoint. */
export function agentTools(businessType: string, sectorMeta: SectorMeta | null, productCount = 0): Anthropic.Tool[] {
  // With the whole catalog in the prompt, searching it only adds a model
  // round trip (and a pause the caller talks into) to reach the same answer.
  const catalogInPrompt = productCount > 0 && productCount <= FULL_CATALOG_MAX;
  const tools: Anthropic.Tool[] = getToolDefinitions(businessType, sectorMeta)
    .filter(t => VOICE_TOOLS.has(t.name))
    .filter(t => !(catalogInPrompt && (t.name === 'search_services' || t.name === 'get_service_detail')))
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
  return tools;
}

// Keeps the request bounded on very long calls. Trimmed only at a caller
// utterance so a tool_use is never separated from its tool_result.
const MAX_MESSAGES = 40;

export function trimMessages(messages: Anthropic.MessageParam[], max = MAX_MESSAGES): Anthropic.MessageParam[] {
  if (messages.length <= max) return messages;
  const isUtterance = (m: Anthropic.MessageParam) =>
    m.role === 'user' && (typeof m.content === 'string' || m.content.every(b => b.type === 'text'));
  // Latest caller utterance that still leaves at most `max` messages; if the
  // tail is one long tool chain, back up to the utterance that started it
  // (slightly over budget beats an orphaned tool_result, which the API rejects).
  for (let i = messages.length - max; i < messages.length; i++) {
    if (isUtterance(messages[i])) return messages.slice(i);
  }
  for (let i = messages.length - max - 1; i > 0; i--) {
    if (isUtterance(messages[i])) return messages.slice(i);
  }
  return messages;
}

// Marks the last block of the last message as a cache breakpoint on a copy,
// so each request reuses everything the previous one already processed.
// Stored history never carries the marker (breakpoints are capped at 4).
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const blocks: any[] = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content.map(b => ({ ...b }));
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { role: last.role, content: blocks }];
}

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

export const INTERRUPTED_MARK = '[caller interrupted]';

export type Channel = 'voice' | 'chat';

export function buildAgentRules(businessType: string, bizName: string, channel: Channel = 'voice'): string {
  const style = channel === 'voice'
    ? `SPEAKING (everything you write is read aloud by a voice on a phone line):
- One or two short sentences (under 35 words), then stop. Answer exactly what was asked — the caller can ask for more. Never recite the whole menu or all the hours unprompted; name two or three highlights and offer more.
- Plain spoken English: no lists, markdown, emoji or symbols. Say "a to c", not "A/C".
- At most one question per reply. Don't read out booking reference numbers unless asked.`
    : `WRITING (WhatsApp / web chat):
- Two to four short sentences. You may use *bold* for service names and prices. No headers or long bullet lists.
- At most one question per reply.`;
  const who = channel === 'voice' ? 'caller' : 'customer';

  const shared = `${style}

USING WHAT YOU KNOW:
- The BUSINESS PROFILE below is complete and authoritative. Answer anything about ${bizName} — services, prices, durations, address, phone, website, hours — straight from it. Give the specifics: name the service and say the price.
- If the profile doesn't cover something, say you can't confirm that from here and a service advisor can, and give the phone number from the profile as the service desk's direct line. Never invent facts, prices or policies.
- Speak as the business ("we", "our shop"). Never mention "the profile", "my information" or "the list" to the caller.
- Never say you will check, look into, or get back on something unless you call the tool in the same reply. Nobody will follow up later.
- Before a tool call say nothing, or at most a few words ("Let me check."). Never think aloud, and never say a date as YYYY-MM-DD.
- Tool results carry a "_spoken_hint": a ready-made sentence for that result. Lightly paraphrase it unless the conversation needs something different.

CONVERSATION:
- Use what the ${who} already told you. Never ask for something they already said, and never ask the same question twice in a row — if you didn't understand, say what you did catch and ask something narrower.
- ${channel === 'voice' ? 'Speech recognition makes mistakes. If words look garbled, make your best guess from context and confirm it in a few words.' : 'Typos happen. Make your best guess from context and confirm it briefly.'}
- A reply of yours ending in "${INTERRUPTED_MARK}" was cut off — the ${who} only heard the part before it. Respond to what they said; don't restart the whole reply.
- If asked, you are an AI assistant — never claim to be human. If they want a person, read out the phone number from the profile.`;

  if (businessType === 'health_nav') {
    return `You are Mogi, a health plan member services specialist for ${bizName}${channel === 'voice' ? ', on a live phone call' : ''}. You are empathetic, clear and warm.

${shared}

HEALTH:
- Never guess coverage, claim outcomes or authorization decisions — use search_services.
- Urgent clinical or emergency concerns: skip pleasantries and act immediately.
- Confirm the member's date of birth or member ID before discussing specific coverage.`;
  }

  return `You are Mogi, the friendly ${channel === 'voice' ? 'receptionist' : 'assistant'} for ${bizName}${channel === 'voice' ? ', on a live phone call' : ''}.

${shared}

BOOKING (live data — always use the tools, one step at a time):
1. Work out which service they need from the profile. Map symptoms to services yourself (squeaking brakes → brakes, warning light → diagnostics). If it's genuinely unclear, suggest an inspection or diagnostic visit.
2. When they want to come in, call check_availability with the service's [id], plus preferred_date (YYYY-MM-DD from the dates below), time_of_day and preferred_time if they mentioned them. Offer the times it returns. If it says requested_open, book that requested_slot in the same turn — they already chose it.
3. When they pick a time, call book_appointment right away with that slot's exact datetime — don't ask "shall I book it?". Then confirm the service, day and time.
4. Only book times check_availability returned. If they ask for another time, check availability for it.
- Adding a service to an appointment they already have (one visit, several jobs): call book_appointment for the new service with the existing booking's exact datetime from "Customer's bookings" — no availability check, never a different time.
5. After booking, you may mention the profile's "pairs well with" add-on once, then ask if there's anything else.
- Existing appointments: list_bookings; to cancel, cancel_booking.`;
}

function describeCaller(session: SessionPayload, orders: Order[] | null | undefined, meta: SectorMeta | null): string {
  const lines: string[] = [];
  const { account } = session;
  if (account.tier !== 'BASIC' || account.store_credit_cents > 0) {
    lines.push(`Customer: ${account.tier} tier, $${(account.store_credit_cents / 100).toFixed(2)} store credit.`);
  }
  const active = (orders ?? []).filter(o => o.status !== 'CANCELLED').slice(0, 3);
  lines.push(`Customer's bookings: ${active.length
    ? active.map(o => `${o.productName}${o.scheduledAt ? ` on ${formatSlotLabel(o.scheduledAt)} [${o.scheduledAt.slice(0, 16)}]` : ''} (${o.status.toLowerCase()})`).join('; ')
    : 'none'}.`);
  lines.push(describeLocalNow(new Date(), meta?.timezone));
  return lines.join('\n');
}

/**
 * The full system prompt for any agent surface: rules + business profile
 * (stable — cache it) and the caller/date block (changes per call).
 */
export function buildSystemPrompt(opts: {
  businessType: string;
  sectorMeta: SectorMeta | null;
  products: Product[];
  session: SessionPayload;
  orders: Order[] | null | undefined;
  channel?: Channel;
  stable?: string;
}): Anthropic.TextBlockParam[] {
  const bizName = opts.sectorMeta?.name ?? opts.businessType;
  const stable = opts.stable
    ?? `${buildAgentRules(opts.businessType, bizName, opts.channel)}\n\n${buildBusinessProfile(opts.businessType, opts.sectorMeta, opts.products)}`;
  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: describeCaller(opts.session, opts.orders, opts.sectorMeta) },
  ];
}

export interface RunTurnOptions {
  onChunk?: OnChunk;
  /** Call-lifetime cache (CallRelay). Without one, history round-trips through KV. */
  cache?: CallCache;
  background?: Background;
  /** Aborted when the caller barges in; stops the model stream and any further tool rounds. */
  signal?: AbortSignal;
  /**
   * For an interrupted turn: the part of the reply the caller actually heard
   * (CallRelay tracks this from Twilio playback marks). Defaults to
   * everything emitted, which over-reports on a phone line.
   */
  heardText?: () => string;
  /** Every timing checkpoint (label, ms since the turn started), for per-call latency metrics. */
  onLap?: (label: string, ms: number) => void;
}

export async function runTurn(
  env: Env,
  session: SessionPayload,
  callSid: string,
  utterance: string,
  opts: RunTurnOptions = {},
): Promise<TurnResult> {
  const { onChunk, cache, background = floating, signal } = opts;
  const { businessType, sub } = session;
  const tag = callSid.slice(-8);
  const t0 = Date.now();
  const lap = (label: string) => {
    const ms = Date.now() - t0;
    console.log(`[${tag}] ⏱ ${label}: ${ms}ms`);
    opts.onLap?.(label, ms);
  };

  console.log(`[${tag}] ${businessType}: "${utterance.slice(0, 80)}"`);

  // ── Load call history ───────────────────────────────────────────────────
  // With a call-lifetime `cache` (the CallRelay Durable Object) history
  // lives in memory for the whole call. Stateless callers (/twilio/turn)
  // fall back to KV.
  const [history, priorMessages] = cache
    ? [cache.history, cache.messages]
    : await Promise.all([loadHistory(env, callSid), loadMessages(env, callSid)]);
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

  const orders = ordersResult.status === 'fulfilled' ? ordersResult.value as Order[] : [];
  const products = productsResult.status === 'fulfilled' ? productsResult.value as Product[] : [];
  const sectorMeta = sectorResult.status === 'fulfilled' && sectorResult.value
    ? (sectorResult.value as SectorMeta)
    : (cache?.sectorMeta ?? null);
  // System prompt: rules + business profile are identical for every turn of
  // every call to this business, so they sit behind a cache breakpoint. The
  // caller/date block after it changes per call. Built once per call.
  const systemPrompt = buildSystemPrompt({
    businessType, sectorMeta, products, session, orders, stable: cache?.systemStable ?? undefined,
  });
  // Don't pin a profile built from a failed lookup for the whole call.
  if (cache && !cache.systemStable && sectorMeta && productsResult.status === 'fulfilled') {
    cache.systemStable = systemPrompt[0].text;
  }

  // Tool defs are byte-identical for every turn of a call — cache them.
  let tools = cache?.toolDefs;
  if (!tools) {
    tools = agentTools(businessType, sectorMeta, products.length);
    if (cache && productsResult.status === 'fulfilled') cache.toolDefs = tools;
  }

  // ── Agentic loop ─────────────────────────────────────────────────────────
  // `turnMessages` is this turn's slice of the conversation: the utterance,
  // then each completed tool_use/tool_result pair. It's committed to
  // history at the end — whole, or as far as it got before a barge-in.
  const turnMessages: Anthropic.MessageParam[] = [{ role: 'user', content: utterance }];
  let spokenResponse = '';
  let finalText = '';
  let interrupted = false;
  let stalled = false;
  // A caller on hold hangs up in about ten seconds. The default 20s x 2
  // attempts let one stalled round go silent for 40s; fail inside that
  // window and apologise instead.
  const anthropic = createAnthropic(env, { timeoutMs: VOICE_MODEL_TIMEOUT_MS, maxRetries: 1 });
  const directToolReply = !/^(0|false)$/i.test(env.VOICE_DIRECT_TOOL_REPLY ?? '');

  // Whether anything has been handed to TTS yet this turn. Governs whether
  // the next flush may break on a clause (first chunk) or must wait for a
  // sentence end (every chunk after it).
  let emittedAny = false;

  const emit = (chunk: string) => {
    if (signal?.aborted) return;
    // The model sometimes thinks aloud before a tool call ("Wednesday is
    // 2026-11-04, and 10 o'clock is 10:00."). A raw ISO date is never meant
    // for the caller, so a sentence carrying one is dropped.
    if (ISO_DATE_RE.test(chunk)) {
      console.log(`[${tag}] dropped reasoning chunk: "${chunk.slice(0, 80)}"`);
      return;
    }
    spokenResponse = spokenResponse ? `${spokenResponse} ${chunk}` : chunk;
    emittedAny = true;
    // Deliberately not awaited — see the OnChunk doc comment.
    onChunk?.(chunk);
  };

  // Pulls every chunk currently available out of `buf` and returns what's left.
  const drain = (buf: string): string => {
    let rest = buf;
    if (!emittedAny) {
      const first = popFirstChunk(rest);
      if (!first) return rest;
      if (first.chunk) emit(first.chunk);
      rest = first.rest;
    }
    const { chunks, rest: remainder } = extractCompleteSentences(rest);
    for (const chunk of chunks) emit(chunk);
    return remainder;
  };

  try {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      if (signal?.aborted) { interrupted = true; break; }
      // The SDK timeout stops at response headers; a stream that stalls
      // after that would hang the turn. Abort the round if no event arrives
      // for VOICE_MODEL_TIMEOUT_MS (also covers a slow retry).
      const round = new AbortController();
      const onCallerAbort = () => round.abort();
      signal?.addEventListener('abort', onCallerAbort, { once: true });
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { stalled = true; round.abort(); }, VOICE_MODEL_TIMEOUT_MS);
      };
      armStall();
      const stream = anthropic.messages.stream({
        model: voiceModel(env),
        max_tokens: 400,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: systemPrompt,
        tools,
        messages: withCacheBreakpoint(trimMessages([...priorMessages, ...turnMessages])),
      }, { signal: round.signal });

      let buffer = '';
      let roundText = '';
      let firstTokenLapped = false;
      let response: Anthropic.Message;
      try {
        for await (const event of stream) {
          armStall();
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (!firstTokenLapped) { lap(`anthropic#${i} first-token`); firstTokenLapped = true; }
            roundText += event.delta.text;
            buffer = drain(buffer + event.delta.text);
          }
        }
        response = await stream.finalMessage();
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        signal?.removeEventListener('abort', onCallerAbort);
      }
      lap(`anthropic#${i} (${response.stop_reason})`);
      const usage = response.usage as any;
      if (usage) {
        lap(`anthropic#${i} usage (in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0})`);
      }

      // Flush any trailing text that didn't end on sentence punctuation
      // (e.g. the model's chatter right before a tool_use block).
      const trailing = buffer.trim();
      if (trailing) emit(trailing);

      if (response.stop_reason !== 'tool_use') {
        finalText = roundText.trim();
        break;
      }

      const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
      // Tools are never aborted midway: a booking that reached D1 must be
      // recorded in history even if the caller talked over the reply.
      const executed = await Promise.all(toolBlocks.map(async (tb) => {
        console.log(`[${tag}] tool: ${tb.name} ${JSON.stringify(tb.input).slice(0, 200)}`);
        const toolT0 = Date.now();
        const result = await executeTool(
          tb.name,
          tb.input as Record<string, unknown>,
          session,
          env,
          sectorMeta,
          cache,
          (label) => console.log(`[${tag}] ⏱ tool:${tb.name}:${label}: ${Date.now() - toolT0}ms`),
          background,
        );
        lap(`tool:${tb.name} total`);
        return { tb, result };
      }));
      lap(`tools#${i} (${toolBlocks.map(t => t.name).join(',')})`);

      const toolResults = executed.map(({ tb, result }): Anthropic.ToolResultBlockParam => {
        // The tool's hand-written voice-shaped response rides along as a
        // phrasing hint (rule: prefer paraphrasing _spoken_hint).
        const payload = (result.data ?? { message: result.spoken_response }) as Record<string, unknown>;
        return {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify({ ...payload, ok: result.success, _spoken_hint: result.spoken_response }),
          ...(result.success ? {} : { is_error: true }),
        };
      });
      turnMessages.push({ role: 'assistant', content: response.content });
      turnMessages.push({ role: 'user', content: toolResults });

      if (signal?.aborted) { interrupted = true; break; }

      // Shortcut: a single tool whose own spoken_response already answers the
      // caller. Speak it and end the turn rather than spending a second
      // model call to restate it. The tool_use/tool_result pair is still
      // committed to history, so the next turn sees the ids and slot
      // datetimes behind what was said.
      if (directToolReply && executed.length === 1
          && canSpeakToolResultDirectly(executed[0].tb.name, executed[0].result)) {
        emit(executed[0].result.spoken_response);
        finalText = executed[0].result.spoken_response;
        lap(`direct-tool-reply:${executed[0].tb.name} (skipped anthropic#${i + 1})`);
        break;
      }
    }
  } catch (err: any) {
    if (signal?.aborted || (!stalled && (err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError'))) {
      interrupted = true;
    } else {
      // An LLM outage mid-call must still leave a consistent history and a
      // spoken reply, not dead air.
      console.error(`[${tag}] turn error`, stalled ? `model stalled > ${VOICE_MODEL_TIMEOUT_MS}ms` : err?.message || err);
      // Also when only a preamble ("Let me check that for you.") went out
      // before a tool round failed — otherwise the caller hears that and
      // then nothing at all.
      if (!finalText) {
        emit(emittedAny
          ? "Sorry, that's taking longer than it should. Could you say that again?"
          : "Sorry, I'm having trouble on my end. Could you say that again?");
      }
      finalText = finalText || spokenResponse;
    }
  }
  lap('runTurn total');

  // ── Commit to history ─────────────────────────────────────────────────────
  let assistantText: string;
  if (interrupted) {
    const heard = (opts.heardText ? opts.heardText() : spokenResponse).trim();
    const ranTools = turnMessages.length > 1;
    if (!heard && !ranTools) {
      console.log(`[${tag}] interrupted before anything was heard — not committed`);
      return { spokenResponse: '', history, interrupted: true, committed: false };
    }
    assistantText = heard ? `${heard} ${INTERRUPTED_MARK}` : INTERRUPTED_MARK;
  } else {
    if (!spokenResponse) emit("Sorry, I'm having trouble right now. Could you say that again?");
    assistantText = finalText || spokenResponse;
  }

  const updatedMessages = trimMessages([...priorMessages, ...turnMessages, { role: 'assistant', content: assistantText }]);
  const updatedHistory: Turn[] = [
    ...history,
    { role: 'user', content: utterance },
    { role: 'assistant', content: interrupted ? assistantText : spokenResponse },
  ];
  if (cache) {
    cache.history = updatedHistory;
    cache.messages = updatedMessages;
  }
  persistTurn(env, callSid, sub, businessType, updatedHistory, updatedMessages, background, !cache);

  return { spokenResponse, history: updatedHistory, interrupted, committed: true };
}

// The answer is already spoken by the time this runs (onChunk delivery
// happens first), so awaiting it would only delay the caller. KV write-behind
// is durability-only — the in-memory cache is what subsequent turns of a
// live call actually read.
function persistTurn(
  env: Env, callSid: string, customerIdHashed: string, businessType: string,
  turns: Turn[], messages: Anthropic.MessageParam[], background: Background, stateless: boolean,
) {
  background(saveHistory(env, callSid, turns).catch(err => console.error('saveHistory error', err.message)));
  // saveTranscript is a SELECT-then-UPDATE against D1 that rewrites the whole
  // (growing) turns array. CallRelay flushes the transcript once when the
  // call ends, so only stateless callers (no end-of-call hook) write it, and
  // only they need the model-side message list back from KV next turn.
  if (!stateless) return;
  background(saveMessages(env, callSid, messages).catch(err => console.error('saveMessages error', err.message)));
  background(saveTranscript(env, { callSid, customerIdHashed, businessType, turns })
    .catch(err => console.error('transcript error', err.message)));
}

/**
 * The caller barged in on a reply that had already been committed in full
 * (the model was done; the audio was still playing). Rewrite that reply in
 * history to what they actually heard, so the next turn doesn't assume they
 * got information they never did.
 */
export function amendInterruptedReply(cache: CallCache, heard: string): void {
  const text = heard.trim() ? `${heard.trim()} ${INTERRUPTED_MARK}` : INTERRUPTED_MARK;
  const lastMsg = cache.messages[cache.messages.length - 1];
  if (lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' && !lastMsg.content.endsWith(INTERRUPTED_MARK)) {
    cache.messages = [...cache.messages.slice(0, -1), { role: 'assistant', content: text }];
  }
  const lastTurn = cache.history[cache.history.length - 1];
  if (lastTurn?.role === 'assistant' && !lastTurn.content.endsWith(INTERRUPTED_MARK)) {
    cache.history = [...cache.history.slice(0, -1), { role: 'assistant', content: text }];
  }
}
