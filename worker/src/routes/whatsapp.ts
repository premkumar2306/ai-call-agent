/*
 * META WHATSAPP BUSINESS POLICY — AI RULES (reference: business.whatsapp.com/policy)
 *
 * 1. OPT-IN REQUIRED: Only message users who have initiated contact first.
 *    This handler only replies — it never sends outbound proactive messages.
 *
 * 2. 24-HOUR SERVICE WINDOW: Free-form replies are only allowed within 24 hours
 *    of the user's last message. KV TTL is set to 86 400 s to match this window.
 *    After expiry, use approved Message Templates (not implemented here — escalate
 *    to a human agent or ask the user to message again).
 *
 * 3. AI / AUTOMATION DISCLOSURE: If a user asks "am I talking to a bot/AI?", Mogi
 *    MUST answer honestly. The system prompt includes an explicit rule for this.
 *    Do NOT claim to be human.
 *
 * 4. OPT-OUT MECHANISM: If a user sends "STOP", "Unsubscribe", or "Cancel", reply
 *    with a confirmation and do NOT send further messages. This handler checks for
 *    opt-out keywords before the agentic loop.
 *
 * 5. NO PROHIBITED CONTENT: Do not send spam, misleading info, or illegal offers.
 *    The Mogi system prompt already prevents hallucinated prices/services.
 *
 * 6. DATA MINIMISATION: Phone numbers are HMAC-hashed before any DB storage.
 *    Raw numbers never appear in D1, KV, or logs.
 *
 * 7. BUSINESS VERIFICATION: A verified Meta Business Account is required before
 *    the WhatsApp Cloud API can send messages. See setup instructions in the
 *    admin dashboard WhatsApp tab.
 *
 * 8. RATE LIMITS: Meta enforces per-number rate limits. This handler also applies
 *    a local KV counter (20 messages / 60 s per customer) to cap Anthropic spend.
 *
 * 9. TEMPLATE MESSAGES: Proactive outbound messages (booking reminders, etc.) must
 *    use pre-approved templates and are NOT handled by this route.
 *
 * 10. GDPR / CCPA: Customer data (hashed IDs, orders, transcripts) must be
 *     deletable on request. Implement a DELETE /admin/customers/:idHashed endpoint
 *     before going to production in regulated markets.
 */

import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { getSector } from '../services/sector.service';
import { getProducts } from '../services/catalog.service';
import { getOrders } from '../services/order.service';
import { executeTool, getToolDefinitions } from '../services/tool-router.service';
import { saveTranscript } from '../services/transcript.service';
import {
  getUnclearServiceEscalationResponse,
  shouldEscalateUnclearService,
} from '../services/voice-guard.service';
import { hashId, getOrCreateCustomer } from '../utils/identity';
import type { Env, SessionPayload } from '../types';

const whatsappRouter = new Hono<HonoEnv>();

// ── Local types ────────────────────────────────────────────────────────────────

type Turn = { role: 'user' | 'assistant'; content: string };

type WaTextMessage  = { from: string; id: string; type: 'text';  text:  { body: string } };
type WaAudioMessage = { from: string; id: string; type: 'audio'; audio: { id: string; mime_type: string } };
type WaMessage      = WaTextMessage | WaAudioMessage | { from: string; id: string; type: string };

// ── Signature verification ─────────────────────────────────────────────────────

async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  header: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison
  if (computed.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

// ── KV helpers ─────────────────────────────────────────────────────────────────

function waHistoryKey(phoneHash: string, businessType: string): string {
  return `wa:${phoneHash}:${businessType}`;
}

async function loadWaHistory(env: Env, phoneHash: string, businessType: string): Promise<Turn[]> {
  const raw = await env.CART.get(waHistoryKey(phoneHash, businessType));
  return raw ? JSON.parse(raw) : [];
}

async function saveWaHistory(env: Env, phoneHash: string, businessType: string, history: Turn[]): Promise<void> {
  await env.CART.put(waHistoryKey(phoneHash, businessType), JSON.stringify(history), { expirationTtl: 86400 });
}

// ── Dedup helpers ──────────────────────────────────────────────────────────────

async function isSeenMessage(env: Env, messageId: string): Promise<boolean> {
  return (await env.CACHE.get(`wa:seen:${messageId}`)) !== null;
}

async function markMessageSeen(env: Env, messageId: string): Promise<void> {
  await env.CACHE.put(`wa:seen:${messageId}`, '1', { expirationTtl: 600 });
}

// ── Rate limit ─────────────────────────────────────────────────────────────────

async function checkAndIncrementWaRateLimit(env: Env, phoneHash: string): Promise<boolean> {
  const key = `rl:wa:${phoneHash}`;
  const raw = await env.CACHE.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 20) return true;
  await env.CACHE.put(key, String(count + 1), { expirationTtl: 60 });
  return false;
}

// ── Business type resolution ───────────────────────────────────────────────────

function resolveBusinessType(phoneNumberId: string, env: Env): string {
  if (env.WA_PHONE_NUMBER_MAP) {
    try {
      const map = JSON.parse(env.WA_PHONE_NUMBER_MAP) as Record<string, string>;
      if (map[phoneNumberId]) return map[phoneNumberId];
    } catch { /* ignore malformed JSON */ }
  }
  return env.WA_DEFAULT_BUSINESS_TYPE ?? 'dental';
}

// ── Opt-out detection ──────────────────────────────────────────────────────────

function isOptOut(text: string): boolean {
  return /\b(stop|unsubscribe|cancel|optout|opt.?out)\b/i.test(text);
}

// ── Meta Graph API helpers ─────────────────────────────────────────────────────

async function downloadWaAudio(env: Env, mediaId: string): Promise<ArrayBuffer | null> {
  try {
    const urlRes = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!urlRes.ok) return null;
    const { url } = await urlRes.json() as { url: string };
    const audioRes = await fetch(url, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!audioRes.ok) return null;
    return audioRes.arrayBuffer();
  } catch {
    return null;
  }
}

async function transcribeWaAudio(env: Env, audioBuffer: ArrayBuffer): Promise<string> {
  try {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true', {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/ogg; codecs=opus',
      },
      body: audioBuffer,
    });
    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  } catch {
    return '';
  }
}

async function sendWaReply(env: Env, to: string, text: string): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v22.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`sendWaReply failed: ${res.status} ${errBody}`);
  }
}

// ── History trim ───────────────────────────────────────────────────────────────

function trimHistory(turns: Turn[], max = 30): Turn[] {
  return turns.slice(-max);
}

// ── GET /whatsapp/webhook — Meta verification ──────────────────────────────────

whatsappRouter.get('/webhook', async (c) => {
  const mode        = c.req.query('hub.mode');
  const verifyToken = c.req.query('hub.verify_token');
  const challenge   = c.req.query('hub.challenge');

  if (mode === 'subscribe' && verifyToken === c.env.WA_VERIFY_TOKEN) {
    return c.text(challenge ?? '', 200);
  }
  return c.text('Forbidden', 403);
});

// ── POST /whatsapp/webhook — message handler ───────────────────────────────────

whatsappRouter.post('/webhook', async (c) => {
  // 1. Read raw body
  const rawBody = await c.req.text();

  // 2. Verify Meta signature
  const sigHeader = c.req.header('x-hub-signature-256') ?? '';
  if (c.env.NODE_ENV === 'production' && c.env.WA_APP_SECRET) {
    const valid = await verifyMetaSignature(c.env.WA_APP_SECRET, rawBody, sigHeader);
    if (!valid) return c.text('Forbidden', 403);
  }

  // 3. Parse body
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.text('OK', 200);
  }

  if (payload?.object !== 'whatsapp_business_account') {
    return c.text('OK', 200);
  }

  // 4. Navigate to message value
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return c.text('OK', 200);

  // Delivery receipts — skip silently
  if (value.statuses && !value.messages) return c.text('OK', 200);

  // 5. Extract message
  const message: WaMessage | undefined = value.messages?.[0];
  if (!message) return c.text('OK', 200);
  const phoneNumberId: string = value.metadata?.phone_number_id ?? '';

  // 6. Dedup
  if (await isSeenMessage(c.env, message.id)) return c.text('OK', 200);
  await markMessageSeen(c.env, message.id);

  // 7. Hash phone
  const phoneHash = await hashId(message.from, c.env.CUSTOMER_HASH_SALT ?? 'dev-hash-salt');

  // 8. Resolve business type
  const businessType = resolveBusinessType(phoneNumberId, c.env);

  // 9. Rate limit
  const overLimit = await checkAndIncrementWaRateLimit(c.env, phoneHash);
  if (overLimit) {
    await sendWaReply(c.env, message.from, "You've sent a lot of messages recently. Please wait a moment before continuing.").catch(() => {});
    return c.text('OK', 200);
  }

  // 10. Opt-out check (text only)
  if (message.type === 'text') {
    const textMsg = message as WaTextMessage;
    if (isOptOut(textMsg.text.body)) {
      await sendWaReply(c.env, message.from, "You've been unsubscribed. Text us any time to start again.").catch(() => {});
      return c.text('OK', 200);
    }
  }

  // 11. Resolve utterance
  let utterance = '';
  if (message.type === 'text') {
    utterance = (message as WaTextMessage).text.body.trim();
  } else if (message.type === 'audio') {
    const audioMsg = message as WaAudioMessage;
    const buf = await downloadWaAudio(c.env, audioMsg.audio.id);
    if (buf) {
      utterance = await transcribeWaAudio(c.env, buf);
    }
    if (!utterance) {
      await sendWaReply(c.env, message.from, "I couldn't make out that voice message. Could you type your request instead?").catch(() => {});
      return c.text('OK', 200);
    }
  } else {
    await sendWaReply(c.env, message.from, "I can only handle text and voice messages. Please type your request.").catch(() => {});
    return c.text('OK', 200);
  }

  try {
    // 12. Get/create customer
    const account = await getOrCreateCustomer(c.env, phoneHash);

    // 13. Build session
    const now = Math.floor(Date.now() / 1000);
    const session: SessionPayload = {
      sub: phoneHash,
      businessType,
      iat: now,
      exp: now + 86400,
      account,
    };

    // 14. Load history
    const history = await loadWaHistory(c.env, phoneHash, businessType);

    // 15. Parallel context fetch
    const [ordersResult, productsResult] = await Promise.allSettled([
      getOrders(c.env, phoneHash, businessType),
      getProducts(c.env, businessType),
    ]);
    const recentOrders = ordersResult.status === 'fulfilled'
      ? ordersResult.value.slice(0, 3).map(o => `${o.productName} (${o.status})`) : [];

    // 16. Sector meta
    const sectorMeta = await getSector(c.env, businessType);
    const bizName = sectorMeta?.name ?? businessType;
    const credit = (account.store_credit_cents / 100).toFixed(2);

    // 17. Voice-guard check
    if (shouldEscalateUnclearService(history, utterance)) {
      const escalationReply = getUnclearServiceEscalationResponse(bizName);
      const updatedHistory: Turn[] = [
        ...history,
        { role: 'user', content: utterance },
        { role: 'assistant', content: escalationReply },
      ];
      await saveWaHistory(c.env, phoneHash, businessType, updatedHistory);
      saveTranscript(c.env, { callSid: `wa:${phoneHash.slice(0, 8)}`, customerIdHashed: phoneHash, businessType, turns: updatedHistory })
        .catch(err => console.error('wa transcript error', err.message));
      await sendWaReply(c.env, message.from, escalationReply).catch(() => {});
      return c.text('OK', 200);
    }

    // 18. Build system prompt
    const systemPrompt =
`You are Mogi, a warm and friendly scheduling assistant for ${bizName}, on WhatsApp.

Customer: ${account.tier} tier | $${credit} store credit
Previous bookings: ${recentOrders.length ? recentOrders.join(', ') : 'none'}

CHANNEL: WhatsApp text chat. You may write 2–4 sentences. Use *bold* for service names and prices.
Do NOT use markdown headers or long bullet lists. Be warm, concise, and helpful.
PRICES: Always use $ (dollars). Never ₹ or other symbols.
HONESTY: If asked whether you are a bot or AI, always say yes — you are Mogi, an AI assistant.

RULES:
1. NEVER guess prices, times, or service names — always call a tool first.
2. If customer has a specific need → call search_services immediately.
3. BOOKING FLOW (one step at a time, never skip):
   Step A — customer mentions need → call search_services → share the top match name and price warmly.
   Step B — customer says yes/interested → call check_availability(service_id=<id from search>) → offer 2–3 slots.
   Step C — customer picks a slot → call book_appointment(product_id, scheduled_at, payment_method=CREDIT_CARD) immediately.
4. AFTER BOOKING: call get_upsells once, offer casually, then wrap up warmly.
5. NO LOOPS: Never repeat a question already answered.
6. CANCEL: "cancel" → call cancel_booking.
7. OPT-OUT: If customer says "stop" or "unsubscribe", acknowledge it politely.
   (The system handles opt-out before this prompt, so this is a safety backstop.)`;

    // 19. Agentic loop
    const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
    const tools: Anthropic.Tool[] = getToolDefinitions(businessType, sectorMeta).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const messages: Anthropic.MessageParam[] = [
      ...history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: utterance },
    ];

    let replyText = '';
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        tools,
        messages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
          console.log(`[wa:${phoneHash.slice(-8)}] tool: ${tb.name}`);
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, c.env, sectorMeta);
          return { type: 'tool_result' as const, tool_use_id: tb.id, content: JSON.stringify(result.data ?? { message: result.spoken_response }) };
        }));
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
      replyText = textBlock?.text?.trim() ?? "Sorry, I had trouble with that. Please try again.";
      break;
    }

    if (!replyText) replyText = "I'm having trouble right now. Please try again.";

    // 20-21. Trim and save history
    const updatedHistory = trimHistory([
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: replyText },
    ], 30);
    await saveWaHistory(c.env, phoneHash, businessType, updatedHistory);

    // 22. Send reply
    await sendWaReply(c.env, message.from, replyText);

    // 23. Fire-and-forget transcript
    saveTranscript(c.env, {
      callSid: `wa:${phoneHash.slice(0, 8)}`,
      customerIdHashed: phoneHash,
      businessType,
      turns: updatedHistory,
    }).catch(err => console.error('wa transcript error', err.message));

    // 24. Return 200
    return c.text('OK', 200);

  } catch (err: any) {
    console.error(`[wa:${phoneHash.slice(-8)}] error:`, err.message);
    await sendWaReply(c.env, message.from, "I'm having technical difficulties. Please try again shortly.").catch(() => {});
    return c.text('OK', 200);
  }
});

export { whatsappRouter };
