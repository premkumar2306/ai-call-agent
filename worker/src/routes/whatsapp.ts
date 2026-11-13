/*
 * META WHATSAPP BUSINESS POLICY — AI RULES (reference: business.whatsapp.com/policy)
 *
 * 1. OPT-IN REQUIRED: This handler only replies. Business-initiated messages
 *    (reminders, missed-call follow-ups, confirmations) live in
 *    services/whatsapp-outbound.ts: approved templates only, off per business
 *    until the owner turns them on, and never to someone who opted out. A
 *    customer's first message here is recorded as their opt-in.
 *
 * 2. 24-HOUR SERVICE WINDOW: Free-form replies are only allowed within 24 hours
 *    of the user's last message. Replies to a message older than that are not
 *    sent; business-initiated confirmations outside the window use the approved
 *    template WA_CONFIRMATION_TEMPLATE (services/whatsapp-api.ts).
 *
 * 3. AI / AUTOMATION DISCLOSURE: If a user asks "am I talking to a bot/AI?", Mogi
 *    MUST answer honestly. The system prompt includes an explicit rule for this.
 *    Do NOT claim to be human.
 *
 * 4. OPT-OUT MECHANISM: "STOP", "Unsubscribe", "बंद करो", "band karo" … (isOptOut)
 *    record an opt-out (messaging_consent) and get a confirmation. No reminder,
 *    follow-up or confirmation is sent to them again, on WhatsApp or SMS, until
 *    they send START / शुरू. Messages they write are still answered.
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
 * 8. RATE LIMITS: Meta enforces per-number rate limits (Graph calls retry once
 *    on throttling). This handler also applies a local KV counter (20 messages
 *    / 60 s per customer) to cap Anthropic spend, and says so once per minute.
 *
 * 9. TEMPLATE MESSAGES: Proactive outbound messages must use pre-approved
 *    templates; see sendBusinessMessage in services/whatsapp-api.ts.
 *
 * 10. DATA RIGHTS: export/erase per customer is /admin/privacy/:business/* (DPDP).
 */

import { businessForWhatsApp } from '../services/self-serve';
import { Hono } from 'hono';
import type Anthropic from '@anthropic-ai/sdk';
import type { HonoEnv } from '../middleware';
import { getSector } from '../services/sector.service';
import { getOrders } from '../services/order.service';
import { executeTool } from '../services/tool-router.service';
import { getProducts } from '../services/catalog.service';
import { agentTools, buildSystemPrompt } from '../services/turn.service';
import { saveTranscript } from '../services/transcript.service';
import { whatsappNotice, recordConsent } from '../services/disclosure';
import { resolveVoiceSettings } from '../services/voice-language';
import { UsageMeter } from '../services/billing/meter';
import { recordWhatsAppTurn } from '../services/billing/service';
import {
  cannedReply, downloadMedia, inboundMessages, markRead, maskId, noteInbound, sendText,
  utteranceOf, withinServiceWindow, type ReplyLanguage, type WaMessage,
} from '../services/whatsapp-api';
import { latestConsent, recordMessagingConsent } from '../services/whatsapp-outbound';
import { applyStatusUpdate } from '../services/whatsapp-templates';
import { notePnidInbound, refreshHealth } from '../services/whatsapp-health';
import { hashId, getOrCreateCustomer } from '../utils/identity';
import { getDefaultBusiness } from '../services/line-config';
import type { Env, SectorMeta, SessionPayload } from '../types';
import {
  agentModel, createAnthropic, customerHashSalt, HTTP_TIMEOUT_MS, isProduction, MAX_TOOL_ROUNDS, timingSafeEqual,
} from '../config';

const whatsappRouter = new Hono<HonoEnv>();

type Turn = { role: 'user' | 'assistant'; content: string };

// ── Signature verification ─────────────────────────────────────────────────────

export async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  header: string,
): Promise<boolean> {
  if (!header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(computed, header.toLowerCase());
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

// ── Dedup ──────────────────────────────────────────────────────────────────────
// Meta redelivers a webhook it thinks failed, for up to a few days; a message
// id is answered once. KV is eventually consistent, so two deliveries in the
// same second could in theory both pass — Meta's retries are minutes apart.

export const DEDUP_TTL_SECONDS = 3 * 86400;

/** True the first time a message id is seen; false for a redelivery. */
export async function claimMessage(env: Env, messageId: string): Promise<boolean> {
  const key = `wa:seen:${messageId}`;
  if ((await env.CACHE.get(key)) !== null) return false;
  await env.CACHE.put(key, '1', { expirationTtl: DEDUP_TTL_SECONDS });
  return true;
}

// ── Rate limit ─────────────────────────────────────────────────────────────────

export const WA_RATE_LIMIT = 20;

/** 'ok', 'limited' (tell the customer, once), or 'silent' (already told this minute). */
export async function rateLimit(env: Env, phoneHash: string): Promise<'ok' | 'limited' | 'silent'> {
  const key = `rl:wa:${phoneHash}`;
  const count = parseInt((await env.CACHE.get(key)) ?? '0', 10) || 0;
  await env.CACHE.put(key, String(count + 1), { expirationTtl: 60 });
  if (count < WA_RATE_LIMIT) return 'ok';
  return count === WA_RATE_LIMIT ? 'limited' : 'silent';
}

// ── Business resolution ────────────────────────────────────────────────────────

/**
 * The business a WhatsApp number answers for: the operator's mapping
 * (whatsapp_numbers), then WA_PHONE_NUMBER_MAP, then — only for the one
 * configured number WA_PHONE_NUMBER_ID, or when none is configured — the
 * default business. Any other unmapped number gets null: no reply as some
 * other business.
 */
export async function resolveBusinessType(phoneNumberId: string, env: Env): Promise<string | null> {
  const mapped = phoneNumberId ? await businessForWhatsApp(env, phoneNumberId) : null;
  if (mapped) return mapped;
  if (env.WA_PHONE_NUMBER_MAP) {
    try {
      const map = JSON.parse(env.WA_PHONE_NUMBER_MAP) as Record<string, string>;
      if (map[phoneNumberId]) return map[phoneNumberId];
    } catch { /* ignore malformed JSON */ }
  }
  if (env.WA_PHONE_NUMBER_ID && phoneNumberId && phoneNumberId !== env.WA_PHONE_NUMBER_ID) return null;
  return (await getDefaultBusiness(env)) ?? env.WA_DEFAULT_BUSINESS_TYPE ?? 'advanced_vtech';
}

// ── Opt-out detection ──────────────────────────────────────────────────────────

// Only a message that *is* an opt-out keyword counts. Matching the keyword
// anywhere would unsubscribe "I need to cancel my appointment" or "can you
// stop by Tuesday?" instead of handing them to the agent. "Cancel" on its own
// is not an opt-out: after a reminder it means "cancel my appointment".
// English, Hindi (Devanagari) and Hinglish.
const OPT_OUT_RE = new RegExp('^\\s*(' + [
  'stop', 'stop all', 'stop messages', 'unsubscribe', 'end', 'quit', 'opt[\\s-]?out',
  'band', 'band karo', 'band karein', 'band kijiye', 'mat bhejo', 'mat bhejiye', 'rok do', 'roko',
  'बंद', 'बंद करो', 'बंद करें', 'बंद कीजिए', 'बंद करे', 'मत भेजो', 'मत भेजें', 'मैसेज मत भेजो', 'रोको', 'रोकें', 'रोक दो', 'अनसब्सक्राइब', 'स्टॉप',
].join('|') + ')\\s*[.!।]*\\s*$', 'iu');
const OPT_IN_RE = /^\s*(start|unstop|subscribe|resume|shuru|shuru karo|शुरू|शुरू करो|शुरू करें|स्टार्ट)\s*[.!।]*\s*$/iu;

export function isOptOut(text: string): boolean {
  return OPT_OUT_RE.test(text.normalize('NFC'));
}

/** START (or शुरू) after an opt-out: business-initiated messages may resume. */
export function isOptIn(text: string): boolean {
  return OPT_IN_RE.test(text.normalize('NFC'));
}

// ── Voice notes ────────────────────────────────────────────────────────────────

/** Deepgram query for a voice note in the business's language (nova-3: hi, multi for Hinglish). */
export function voiceNoteQuery(lang: ReplyLanguage): string {
  const language = lang === 'hi' ? 'hi' : lang === 'hi-en' ? 'multi' : 'en';
  return new URLSearchParams({ model: 'nova-3', language, smart_format: 'true' }).toString();
}

async function transcribeVoiceNote(env: Env, mediaId: string, lang: ReplyLanguage): Promise<string> {
  if (!env.DEEPGRAM_API_KEY) return '';
  const media = await downloadMedia(env, mediaId);
  if (!media) return '';
  try {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${voiceNoteQuery(lang)}`, {
      method: 'POST',
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': media.mimeType.split(';')[0] || 'audio/ogg' },
      body: media.bytes,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[wa] voice note transcription failed: HTTP ${res.status}`);
      return '';
    }
    const data = await res.json() as any;
    return String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
  } catch (e: any) {
    console.error('[wa] voice note transcription failed:', e?.message || e);
    return '';
  }
}

// ── DPDP notice: once per customer per business ────────────────────────────────

async function noticeAlreadyGiven(env: Env, businessType: string, phoneHash: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 FROM consent_records WHERE business_type = ? AND channel = 'whatsapp' AND customer_id_hashed = ? LIMIT 1`,
    ).bind(businessType, phoneHash).first();
    return !!row;
  } catch (e: any) {
    console.error('[wa] consent lookup failed', e?.message || e);
    return false;   // fail towards telling them
  }
}

function trimHistory(turns: Turn[], max = 30): Turn[] {
  return turns.slice(-max);
}

// ── GET /whatsapp/webhook — Meta verification ──────────────────────────────────

whatsappRouter.get('/webhook', async (c) => {
  const mode        = c.req.query('hub.mode');
  const verifyToken = c.req.query('hub.verify_token');
  const challenge   = c.req.query('hub.challenge');

  if (mode === 'subscribe' && c.env.WA_VERIFY_TOKEN && verifyToken
      && timingSafeEqual(verifyToken, c.env.WA_VERIFY_TOKEN)) {
    return c.text(challenge ?? '', 200);
  }
  return c.text('Forbidden', 403);
});

// ── POST /whatsapp/webhook — message handler ───────────────────────────────────

whatsappRouter.post('/webhook', async (c) => {
  const rawBody = await c.req.text();

  // Verify Meta's signature. In production a missing WA_APP_SECRET rejects
  // everything rather than silently accepting unsigned payloads.
  const sigHeader = c.req.header('x-hub-signature-256') ?? '';
  if (c.env.WA_APP_SECRET) {
    if (!await verifyMetaSignature(c.env.WA_APP_SECRET, rawBody, sigHeader)) return c.text('Forbidden', 403);
  } else if (isProduction(c.env)) {
    console.error('[wa] WA_APP_SECRET not set — rejecting webhook');
    return c.text('Forbidden', 403);
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return c.text('OK', 200); }

  // Template approvals and number-quality changes (subscribe to these
  // fields in Meta as well as "messages").
  c.executionCtx.waitUntil(handleAccountUpdates(c.env, payload)
    .catch(err => console.error('[wa] account update failed:', err?.message || err)));

  // Status-only webhooks (sent / delivered / read / failed) yield no messages.
  for (const { message, phoneNumberId } of inboundMessages(payload)) {
    if (!await claimMessage(c.env, message.id)) continue;
    // Meta retries any webhook that isn't acknowledged quickly, so the LLM
    // loop runs after the 200 goes out (dedup above makes retries harmless).
    c.executionCtx.waitUntil(
      handleMessage(c.env, message, phoneNumberId)
        .catch(err => console.error('[wa] unhandled error:', err?.message || err)),
    );
  }
  return c.text('OK', 200);
});

async function handleAccountUpdates(env: Env, payload: any): Promise<void> {
  if (payload?.object !== 'whatsapp_business_account') return;
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field === 'message_template_status_update') {
        if (await applyStatusUpdate(env, change.value)) {
          console.log(`[wa] template ${change.value?.message_template_name}/${change.value?.message_template_language}: ${change.value?.event}`);
        }
      } else if (change?.field === 'phone_number_quality_update') {
        console.warn(`[wa] number quality update: ${change.value?.event} (${change.value?.current_limit ?? ''}); refreshing health`);
        await refreshHealth(env);
      }
    }
  }
}

async function handleMessage(env: Env, message: WaMessage, phoneNumberId: string): Promise<void> {
  // Webhook health (Operator → WhatsApp): when each number last got a message.
  if (phoneNumberId) await notePnidInbound(env, phoneNumberId).catch(() => undefined);
  const businessType = await resolveBusinessType(phoneNumberId, env);
  if (!businessType) {
    console.warn(`[wa] message to unmapped phone_number_id ${maskId(phoneNumberId)}; map it in Operator → WhatsApp. Not replying.`);
    return;
  }
  // Replies go out from the number the customer wrote to.
  const fromNumber = phoneNumberId || env.WA_PHONE_NUMBER_ID || '';
  const phoneHash = await hashId(message.from, customerHashSalt(env));
  const sentAt = Number(message.timestamp) || Math.floor(Date.now() / 1000);

  // A redelivery older than the 24-hour window can't be answered free-form.
  if (!withinServiceWindow(sentAt)) {
    console.warn(`[wa:${phoneHash.slice(-8)}] message older than 24 h; not replying`);
    return;
  }
  await noteInbound(env, phoneHash, sentAt, fromNumber);
  const reply = (text: string) => sendText(env, fromNumber, message.from, text);

  const sectorMeta = await getSector(env, businessType) as SectorMeta | null;
  const lang = resolveVoiceSettings(sectorMeta).language as ReplyLanguage;

  const limit = await rateLimit(env, phoneHash);
  if (limit !== 'ok') {
    if (limit === 'limited') await reply(cannedReply('rateLimited', lang));
    return;
  }
  await markRead(env, fromNumber, message.id);

  const said = utteranceOf(message);
  if (said.kind === 'ignore') return;
  if (said.kind === 'reply') { await reply(cannedReply(said.canned, lang)); return; }

  let utterance = '';
  if (said.kind === 'text') {
    utterance = said.text;
    if (isOptOut(utterance)) {
      await recordMessagingConsent(env, { businessType, phoneHash, action: 'opt_out', source: `keyword:${utterance.trim().slice(0, 30)}` });
      await reply(cannedReply('optedOut', lang));
      return;
    }
    if (isOptIn(utterance) && (await latestConsent(env, businessType, phoneHash)) === 'opt_out') {
      await recordMessagingConsent(env, { businessType, phoneHash, action: 'opt_in', source: `keyword:${utterance.trim().slice(0, 30)}` });
      await reply(cannedReply('optedIn', lang));
      return;
    }
  } else {
    utterance = await transcribeVoiceNote(env, said.mediaId, lang);
    if (!utterance) { await reply(cannedReply('voiceFailed', lang)); return; }
  }
  // First contact is the customer's opt-in to hear from this business. After
  // a STOP, chatting is still answered (they wrote first), but reminders and
  // follow-ups stay off until they send START.
  if ((await latestConsent(env, businessType, phoneHash)) === null) {
    await recordMessagingConsent(env, { businessType, phoneHash, action: 'opt_in', source: 'whatsapp_inbound' });
  }

  try {
    const account = await getOrCreateCustomer(env, phoneHash);
    const now = Math.floor(Date.now() / 1000);
    const session: SessionPayload = {
      sub: phoneHash,
      businessType,
      // The WhatsApp number is the callback number for bookings and messages.
      callerPhone: `+${message.from.replace(/\D/g, '')}`,
      iat: now,
      exp: now + 86400,
      account,
    };

    const [history, orders, products, noticeGiven] = await Promise.all([
      loadWaHistory(env, phoneHash, businessType),
      getOrders(env, phoneHash, businessType).catch(() => []),
      getProducts(env, businessType).catch(() => []),
      noticeAlreadyGiven(env, businessType, phoneHash),
    ]);

    // DPDP: the AI/privacy notice before the first reply this customer ever
    // gets from this business (not every 24 hours).
    const notice = noticeGiven ? null : whatsappNotice(sectorMeta);
    if (notice && await reply(notice)) {
      await recordConsent(env, {
        businessType, channel: 'whatsapp', callSid: `wa:${phoneHash.slice(0, 8)}`,
        customerIdHashed: phoneHash, noticeText: notice, playedAt: new Date(),
      });
    }

    // Same rules, business profile and tools as the phone agent, chat-formatted.
    const systemPrompt: Anthropic.TextBlockParam[] = [
      ...buildSystemPrompt({ businessType, sectorMeta, products, session, orders, channel: 'chat' }),
      { type: 'text', text: 'OPT-OUT: if the customer says "stop" or "unsubscribe", acknowledge it politely. (Handled before you see it; this is a backstop.)' },
    ];

    const anthropic = createAnthropic(env);
    const tools = agentTools(businessType, sectorMeta, products.length);
    const messages: Anthropic.MessageParam[] = [
      ...history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: utterance },
    ];

    let replyText = '';
    const meter = new UsageMeter();
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const response = await anthropic.messages.create({
        model: agentModel(env),
        max_tokens: 600,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: systemPrompt,
        tools,
        messages,
      });
      meter.addLlm(agentModel(env), response.usage);

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
          console.log(`[wa:${phoneHash.slice(-8)}] tool: ${tb.name}`);
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, session, env, sectorMeta);
          const payload = (result.data ?? { message: result.spoken_response }) as Record<string, unknown>;
          return {
            type: 'tool_result' as const,
            tool_use_id: tb.id,
            content: JSON.stringify({ ...payload, ok: result.success, _spoken_hint: result.spoken_response }),
            ...(result.success ? {} : { is_error: true }),
          };
        }));
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      replyText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text.trim()).filter(Boolean).join(' ');
      break;
    }
    if (!replyText) replyText = cannedReply('error', lang);

    const updatedHistory = trimHistory([
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: replyText },
    ], 30);
    await saveWaHistory(env, phoneHash, businessType, updatedHistory);

    await reply(replyText);

    await saveTranscript(env, {
      callSid: `wa:${phoneHash.slice(0, 8)}`,
      customerIdHashed: phoneHash,
      businessType,
      turns: updatedHistory,
    }).catch(err => console.error('wa transcript error', err.message));

    // Usage metering (conversation count + model tokens); never throws.
    await recordWhatsAppTurn(env, businessType, phoneHash, meter.llmModel ?? agentModel(env), meter.llm);
  } catch (err: any) {
    console.error(`[wa:${phoneHash.slice(-8)}] error:`, err?.message || err);
    await reply(cannedReply('error', lang));
  }
}

export { whatsappRouter };
