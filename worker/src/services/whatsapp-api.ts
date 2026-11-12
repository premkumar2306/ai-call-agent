// WhatsApp Cloud API (Meta Graph) client and the pure helpers around it.
// Reference: developers.facebook.com/docs/whatsapp/cloud-api
//
// Everything that talks to graph.facebook.com goes through graphFetch(), so
// the API version lives in one place, errors are logged without tokens, and
// Meta's throttling gets one polite retry.

import { HTTP_TIMEOUT_MS } from '../config';
import type { Env } from '../types';

/**
 * The Graph API version, pinned here and nowhere else. Meta supports a version
 * for about two years after the next one ships; bump it deliberately, after
 * reading the changelog. WA_GRAPH_API_VERSION (a plain var) can override it
 * without a redeploy of code.
 */
export const GRAPH_API_VERSION = 'v24.0';

export function graphBase(env: Pick<Env, 'WA_GRAPH_API_VERSION'>): string {
  const v = env.WA_GRAPH_API_VERSION && /^v\d+\.\d+$/.test(env.WA_GRAPH_API_VERSION) ? env.WA_GRAPH_API_VERSION : GRAPH_API_VERSION;
  return `https://graph.facebook.com/${v}`;
}

/** Meta's limit on a text message body. */
export const WA_TEXT_MAX = 4096;

/** The customer-service window: free-form messages only this long after the customer's last message. */
export const SERVICE_WINDOW_SECONDS = 24 * 3600;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Removes anything token-shaped from a string before it is logged. */
export function redactSecrets(s: string, ...secrets: (string | undefined)[]): string {
  let out = s;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  return out
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, '[redacted]')                  // Meta access tokens
    .replace(/(access_token=)[^&\s"]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
}

/**
 * Splits a reply into WhatsApp-sized messages, breaking at paragraph, then
 * line, then sentence, then word boundaries; never mid-word unless a single
 * word is longer than the limit.
 */
export function splitMessage(text: string, max = WA_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', '। ', '? ', '! ', ' ']) {
      const i = window.lastIndexOf(sep);
      if (i > max / 3) { cut = i + (sep.trim() ? sep.length - 1 : 0); break; }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Whether a free-form message may still be sent, given the customer's last message time (unix seconds). */
export function withinServiceWindow(lastInboundSec: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return typeof lastInboundSec === 'number' && lastInboundSec > 0 && nowSec - lastInboundSec < SERVICE_WINDOW_SECONDS;
}

/** A template body parameter: Meta rejects newlines, tabs and runs of more than four spaces. */
export function templateParam(text: string, max = 1024): string {
  return text.replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max);
}

export function maskId(id: string): string {
  return id.length > 4 ? `…${id.slice(-4)}` : id;
}

// ── Inbound webhook parsing ──────────────────────────────────────────────────

export interface WaInbound {
  phoneNumberId: string;
  message: WaMessage;
}

export type WaMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  [k: string]: any;
};

/**
 * Every customer message in a webhook payload. Meta batches: one POST can
 * carry several entries, changes and messages. Status-only changes
 * (sent/delivered/read/failed) yield nothing.
 */
export function inboundMessages(payload: any): WaInbound[] {
  if (payload?.object !== 'whatsapp_business_account') return [];
  const out: WaInbound[] = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field && change.field !== 'messages') continue;
      const value = change?.value;
      const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');
      for (const m of Array.isArray(value?.messages) ? value.messages : []) {
        if (m && typeof m.from === 'string' && typeof m.id === 'string' && typeof m.type === 'string') {
          out.push({ phoneNumberId, message: m });
        }
      }
    }
  }
  return out;
}

export type ReplyLanguage = 'en' | 'hi' | 'hi-en';

const CANNED: Record<string, Record<ReplyLanguage, string>> = {
  unsupported: {
    en: "Sorry, I can't open that kind of message. Please type your question, or send a voice note.",
    hi: 'माफ़ कीजिए, मैं इस तरह का मैसेज नहीं खोल सकती। कृपया अपना सवाल लिखकर भेजें, या वॉइस नोट भेजें।',
    'hi-en': "Sorry, main is type ka message open nahi kar sakti. Please apna sawaal type karein, ya voice note bhejein.",
  },
  media: {
    en: "Thanks! I can't view photos, videos or files here. Please tell me in a message what you need, and our team will see what you sent.",
    hi: 'धन्यवाद! मैं यहाँ फ़ोटो, वीडियो या फ़ाइल नहीं देख सकती। कृपया मैसेज में बताइए कि आपको क्या चाहिए।',
    'hi-en': 'Thanks! Main yahan photo, video ya file nahi dekh sakti. Please message mein bataiye aapko kya chahiye.',
  },
  voiceFailed: {
    en: "I couldn't make out that voice message. Could you type your request instead?",
    hi: 'मैं वह वॉइस मैसेज समझ नहीं पाई। क्या आप अपना सवाल लिखकर भेज सकते हैं?',
    'hi-en': 'Main woh voice message samajh nahi paayi. Kya aap apna sawaal type kar sakte hain?',
  },
  rateLimited: {
    en: "You've sent a lot of messages in a short time. Please wait a minute, then continue.",
    hi: 'आपने कम समय में बहुत सारे मैसेज भेजे हैं। कृपया एक मिनट रुककर फिर लिखें।',
    'hi-en': 'Aapne kam time mein bahut saare messages bheje hain. Please ek minute ruk kar phir likhein.',
  },
  optedOut: {
    en: "You've been unsubscribed. Text us any time to start again.",
    hi: 'आपको सब्सक्रिप्शन से हटा दिया गया है। दोबारा शुरू करने के लिए कभी भी मैसेज करें।',
    'hi-en': 'Aapko unsubscribe kar diya gaya hai. Dobara shuru karne ke liye kabhi bhi message karein.',
  },
  error: {
    en: "I'm having technical difficulties. Please try again shortly.",
    hi: 'अभी तकनीकी दिक्कत है। कृपया थोड़ी देर में फिर कोशिश करें।',
    'hi-en': 'Abhi technical problem hai. Please thodi der mein phir try karein.',
  },
};

export function cannedReply(kind: keyof typeof CANNED, lang: ReplyLanguage = 'en'): string {
  return CANNED[kind][lang] ?? CANNED[kind].en;
}

export type Utterance =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; mediaId: string; mimeType?: string }
  | { kind: 'ignore' }
  | { kind: 'reply'; canned: keyof typeof CANNED };

/**
 * What the customer said, as text for the agent. Interactive replies,
 * locations and shared contacts become a short text line; voice notes need
 * transcribing; reactions and system notices are ignored; anything else gets
 * a polite canned reply.
 */
export function utteranceOf(m: WaMessage): Utterance {
  switch (m.type) {
    case 'text': {
      const body = String(m.text?.body ?? '').trim();
      return body ? { kind: 'text', text: body } : { kind: 'ignore' };
    }
    case 'interactive': {
      const i = m.interactive ?? {};
      const r = i.button_reply ?? i.list_reply;
      if (r?.title) return { kind: 'text', text: [r.title, r.description].filter(Boolean).join(' — ') };
      if (i.nfm_reply?.response_json) return { kind: 'text', text: `Form reply: ${String(i.nfm_reply.response_json).slice(0, 1000)}` };
      return { kind: 'reply', canned: 'unsupported' };
    }
    case 'button':   // quick-reply button on a template message
      return m.button?.text ? { kind: 'text', text: String(m.button.text) } : { kind: 'ignore' };
    case 'audio':
      return m.audio?.id ? { kind: 'audio', mediaId: String(m.audio.id), mimeType: m.audio.mime_type } : { kind: 'reply', canned: 'voiceFailed' };
    case 'location': {
      const l = m.location ?? {};
      const place = [l.name, l.address].filter(Boolean).join(', ');
      const coords = typeof l.latitude === 'number' && typeof l.longitude === 'number' ? ` (${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)})` : '';
      return { kind: 'text', text: `[The customer shared a location: ${place || 'a pin'}${coords}]` };
    }
    case 'contacts': {
      const cards = (Array.isArray(m.contacts) ? m.contacts : []).slice(0, 5).map((c: any) => {
        const name = c?.name?.formatted_name ?? [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(' ');
        const phone = c?.phones?.[0]?.phone ?? c?.phones?.[0]?.wa_id ?? '';
        return [name, phone].filter(Boolean).join(' ');
      }).filter(Boolean);
      return cards.length ? { kind: 'text', text: `[The customer shared contact details: ${cards.join('; ')}]` } : { kind: 'reply', canned: 'unsupported' };
    }
    case 'image':
    case 'video':
    case 'document': {
      const caption = String(m[m.type]?.caption ?? '').trim();
      return caption
        ? { kind: 'text', text: `${caption}\n[The customer also sent a ${m.type === 'document' ? 'file' : m.type}, which you cannot see.]` }
        : { kind: 'reply', canned: 'media' };
    }
    case 'reaction':
    case 'system':
    case 'request_welcome':
      return { kind: 'ignore' };
    default:   // sticker, order, unsupported, …
      return { kind: 'reply', canned: 'unsupported' };
  }
}

// ── Graph calls ──────────────────────────────────────────────────────────────

export interface GraphResult<T = any> { ok: boolean; status: number; data: T | null; errorCode?: number }

/** Meta's throttling codes: account / pair / per-number rate limits. */
const THROTTLE_CODES = new Set([4, 80007, 130429, 131048, 131056]);

/**
 * One Graph request. Never throws; failures are logged as status + Meta's
 * error code and message, with tokens redacted. One retry after 429/5xx or a
 * throttling code.
 */
export async function graphFetch<T = any>(
  env: Env, path: string, init: { method?: string; body?: unknown } = {}, what = 'graph', retries = 1,
): Promise<GraphResult<T>> {
  const url = path.startsWith('https://') ? path : `${graphBase(env)}/${path.replace(/^\//, '')}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN ?? ''}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e: any) {
      console.error(`[wa] ${what} request failed: ${redactSecrets(String(e?.message || e), env.WA_ACCESS_TOKEN)}`);
      return { ok: false, status: 0, data: null };
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok) return { ok: true, status: res.status, data };
    const code = Number(data?.error?.code) || undefined;
    if (attempt < retries && (res.status === 429 || res.status >= 500 || (code && THROTTLE_CODES.has(code)))) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const msg = data?.error ? `code ${data.error.code}${data.error.error_subcode ? `/${data.error.error_subcode}` : ''}: ${data.error.message ?? ''}` : text.slice(0, 200);
    console.error(`[wa] ${what} failed: HTTP ${res.status} ${redactSecrets(msg, env.WA_ACCESS_TOKEN, env.WA_APP_SECRET)}${code === 190 ? ' (access token expired or invalid: renew WA_ACCESS_TOKEN)' : ''}${code === 131047 ? ' (outside the 24-hour window: needs a template)' : ''}`);
    return { ok: false, status: res.status, data, errorCode: code };
  }
}

/** Sends a text, split into as many messages as its length needs. True if every part went. */
export async function sendText(env: Env, phoneNumberId: string, to: string, text: string, replyTo?: string): Promise<boolean> {
  let ok = true;
  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    const r = await graphFetch(env, `${encodeURIComponent(phoneNumberId)}/messages`, {
      body: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
        ...(replyTo && i === 0 ? { context: { message_id: replyTo } } : {}),
        text: { preview_url: false, body: parts[i] },
      },
    }, 'send text');
    ok &&= r.ok;
    if (!r.ok) break;
  }
  return ok;
}

export async function sendTemplate(
  env: Env, phoneNumberId: string, to: string, name: string, languageCode: string, bodyParams: string[] = [],
): Promise<boolean> {
  const r = await graphFetch(env, `${encodeURIComponent(phoneNumberId)}/messages`, {
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: {
        name, language: { code: languageCode },
        ...(bodyParams.length ? { components: [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: templateParam(t) })) }] } : {}),
      },
    },
  }, `send template ${name}`);
  return r.ok;
}

/** Blue ticks, plus the "typing…" indicator while the reply is written (dismissed by the reply or after 25 s). */
export async function markRead(env: Env, phoneNumberId: string, messageId: string): Promise<void> {
  await graphFetch(env, `${encodeURIComponent(phoneNumberId)}/messages`, {
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
  }, 'mark read', 0);
}

/** A voice note's bytes: the media id resolves to a short-lived URL that needs the same token. */
export async function downloadMedia(env: Env, mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  const meta = await graphFetch<{ url?: string; mime_type?: string }>(env, encodeURIComponent(mediaId), {}, 'media lookup');
  const url = meta.data?.url;
  if (!meta.ok || !url || !/^https:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN ?? ''}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`[wa] media download failed: HTTP ${res.status}`);
      return null;
    }
    return { bytes: await res.arrayBuffer(), mimeType: meta.data?.mime_type ?? res.headers.get('content-type') ?? 'audio/ogg' };
  } catch (e: any) {
    console.error(`[wa] media download failed: ${redactSecrets(String(e?.message || e), env.WA_ACCESS_TOKEN)}`);
    return null;
  }
}

// ── 24-hour window and opt-out state ─────────────────────────────────────────
// Keyed by the hashed customer number (never the raw number).

const lastInboundKey = (phoneHash: string) => `wa:last:${phoneHash}`;
const optOutKey = (phoneHash: string) => `wa:optout:${phoneHash}`;

export async function noteInbound(env: Env, phoneHash: string, atSec: number, phoneNumberId: string): Promise<void> {
  await env.CACHE.put(lastInboundKey(phoneHash), JSON.stringify({ at: atSec, pnid: phoneNumberId }), { expirationTtl: SERVICE_WINDOW_SECONDS + 3600 });
}

export async function lastInbound(env: Env, phoneHash: string): Promise<{ at: number; pnid: string } | null> {
  try {
    const raw = await env.CACHE.get(lastInboundKey(phoneHash));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function setOptedOut(env: Env, phoneHash: string, out: boolean): Promise<void> {
  if (out) await env.CACHE.put(optOutKey(phoneHash), '1');
  else await env.CACHE.delete(optOutKey(phoneHash));
}

export async function isOptedOut(env: Env, phoneHash: string): Promise<boolean> {
  return (await env.CACHE.get(optOutKey(phoneHash))) !== null;
}

/** Template language code for a business's language, unless WA_TEMPLATE_LANGUAGE pins one. */
export function templateLanguage(env: Pick<Env, 'WA_TEMPLATE_LANGUAGE'>, lang: ReplyLanguage): string {
  if (env.WA_TEMPLATE_LANGUAGE) return env.WA_TEMPLATE_LANGUAGE;
  return lang === 'hi' ? 'hi' : 'en';
}

/**
 * Sends a business-initiated message (a booking confirmation) the way the
 * 24-hour rule allows: free-form text inside the window; outside it, the
 * approved template WA_CONFIRMATION_TEMPLATE with the text as its one body
 * parameter {{1}}; with no template configured, nothing (logged). Skips
 * customers who opted out.
 */
export async function sendBusinessMessage(
  env: Env, opts: { phoneNumberId: string; to: string; phoneHash: string; text: string; lang: ReplyLanguage },
): Promise<'text' | 'template' | 'skipped'> {
  if (await isOptedOut(env, opts.phoneHash)) return 'skipped';
  const last = await lastInbound(env, opts.phoneHash);
  if (withinServiceWindow(last?.at)) return (await sendText(env, opts.phoneNumberId, opts.to, opts.text)) ? 'text' : 'skipped';
  const template = env.WA_CONFIRMATION_TEMPLATE?.trim();
  if (!template) {
    console.log('[wa] outside the 24-hour window and WA_CONFIRMATION_TEMPLATE is not set; not sending');
    return 'skipped';
  }
  return (await sendTemplate(env, opts.phoneNumberId, opts.to, template, templateLanguage(env, opts.lang), [opts.text])) ? 'template' : 'skipped';
}

/** The WhatsApp number (phone_number_id) a business is mapped to, if any. */
export async function whatsappNumberOf(env: Env, businessType: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT phone_number_id AS id FROM whatsapp_numbers WHERE business_type = ? ORDER BY updated_at DESC LIMIT 1')
      .bind(businessType).first<{ id: string }>();
    return row?.id ?? null;
  } catch { return null; }
}

/**
 * Booking confirmation over WhatsApp for a booking made on a phone call.
 * Only when the operator has configured the approved template
 * (WA_CONFIRMATION_TEMPLATE) and the business has a WhatsApp number: off by
 * default, so nothing changes for a business that hasn't set it up. A
 * customer chatting right now (inside the 24-hour window) already got the
 * confirmation as a chat reply, so nothing more is sent then.
 */
export async function confirmBookingOnWhatsApp(
  env: Env, opts: { businessType: string; phone: string; phoneHash: string; text: string; lang: ReplyLanguage },
): Promise<'template' | 'skipped'> {
  if (!env.WA_CONFIRMATION_TEMPLATE?.trim() || !env.WA_ACCESS_TOKEN) return 'skipped';
  if (withinServiceWindow((await lastInbound(env, opts.phoneHash))?.at)) return 'skipped';
  const phoneNumberId = await whatsappNumberOf(env, opts.businessType);
  if (!phoneNumberId) return 'skipped';
  const to = opts.phone.replace(/\D/g, '');
  const r = await sendBusinessMessage(env, { phoneNumberId, to, phoneHash: opts.phoneHash, text: opts.text, lang: opts.lang });
  return r === 'template' ? 'template' : 'skipped';
}
