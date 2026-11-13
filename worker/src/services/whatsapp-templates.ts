// WhatsApp message templates: Avery's four utility templates in English,
// Hindi and Hinglish, created and synced through the Graph API
// (/{WABA_ID}/message_templates), and the operator's choice of which
// template family each event uses.
//
// Meta's rules this file follows:
// - Business-initiated messages outside the 24-hour customer-service window
//   must be an APPROVED template; we only ever pick APPROVED rows.
// - UTILITY category: each message is about the customer's own booking or
//   call. Meta may re-categorise one as MARKETING; we then treat it like
//   any other non-approved template (not used).
// - A body may not start or end with a parameter, and parameters are
//   numbered in order. Every body ends with how to opt out (STOP).
// - One template name can hold several languages. Hinglish is written in
//   Latin script and Meta has no code for it, so it is <family>_hinglish in en.

import type { Env } from '../types';
import { graphFetch, type ReplyLanguage } from './whatsapp-api';

export const EVENTS = ['confirmation', 'reminder', 'cancellation', 'missed_call'] as const;
export type WaEvent = typeof EVENTS[number];
export const VARIANTS: ReplyLanguage[] = ['en', 'hi', 'hi-en'];

export const isEvent = (x: unknown): x is WaEvent => typeof x === 'string' && (EVENTS as readonly string[]).includes(x);

/** Template name and Meta language code of one variant of a family. */
export function variantName(family: string, variant: ReplyLanguage): { name: string; language: string } {
  return variant === 'hi-en' ? { name: `${family}_hinglish`, language: 'en' } : { name: family, language: variant };
}

export interface TemplateDef {
  event: WaEvent;
  family: string;
  /** Example values Meta needs to review the template (one per parameter). */
  example: string[];
  body: Record<ReplyLanguage, string>;
}

// {{1}} business name; {{2}} service; {{3}} date and time.
export const DEFAULT_TEMPLATES: TemplateDef[] = [
  {
    event: 'confirmation', family: 'avery_booking_confirmation',
    example: ['Sharma Dental Clinic', 'Dental check-up', 'Mon, 18 Nov, 10:30 am'],
    body: {
      en: 'Hello from {{1}}. Your {{2}} is confirmed for {{3}}. Reply here if you need to change it. Reply STOP to opt out.',
      hi: 'नमस्ते, {{1}} की ओर से। आपका {{2}} {{3}} के लिए पक्का है। बदलाव के लिए यहीं जवाब दें। मैसेज बंद करने के लिए STOP लिखें।',
      'hi-en': 'Namaste, {{1}} se. Aapka {{2}} {{3}} ke liye confirm hai. Change karna ho toh yahin reply karein. Messages band karne ke liye STOP likhein.',
    },
  },
  {
    event: 'reminder', family: 'avery_appointment_reminder',
    example: ['Sharma Dental Clinic', 'Dental check-up', 'tomorrow, 10:30 am'],
    body: {
      en: 'Reminder from {{1}}: your {{2}} is {{3}}. Reply here to reschedule or cancel. Reply STOP to opt out.',
      hi: 'नमस्ते, {{1}} की ओर से याद दिलाना: आपका {{2}} {{3}} है। समय बदलने या रद्द करने के लिए यहीं जवाब दें। मैसेज बंद करने के लिए STOP लिखें।',
      'hi-en': 'Reminder, {{1}} se: aapka {{2}} {{3}} hai. Reschedule ya cancel karne ke liye yahin reply karein. Messages band karne ke liye STOP likhein.',
    },
  },
  {
    event: 'cancellation', family: 'avery_booking_cancellation',
    example: ['Sharma Dental Clinic', 'Dental check-up', 'Mon, 18 Nov, 10:30 am'],
    body: {
      en: 'Hello from {{1}}. Your {{2}} on {{3}} has been cancelled. Reply here if you would like a new time. Reply STOP to opt out.',
      hi: 'नमस्ते, {{1}} की ओर से। आपका {{2}} ({{3}}) रद्द कर दिया गया है। नया समय चाहिए तो यहीं जवाब दें। मैसेज बंद करने के लिए STOP लिखें।',
      'hi-en': 'Namaste, {{1}} se. Aapka {{2}} ({{3}}) cancel ho gaya hai. Naya time chahiye toh yahin reply karein. Messages band karne ke liye STOP likhein.',
    },
  },
  {
    event: 'missed_call', family: 'avery_missed_call',
    example: ['Sharma Dental Clinic'],
    body: {
      en: 'Sorry we missed your call to {{1}}. Reply to this message and we will help you here on WhatsApp: book, reschedule or ask a question. Reply STOP to opt out.',
      hi: 'माफ़ कीजिए, {{1}} पर आपकी कॉल पूरी नहीं हो पाई। इस मैसेज का जवाब दें, हम यहीं WhatsApp पर मदद करेंगे: बुकिंग, समय बदलना या कोई सवाल। मैसेज बंद करने के लिए STOP लिखें।',
      'hi-en': 'Sorry, {{1}} par aapki call poori nahi ho paayi. Is message ka reply karein, hum yahin WhatsApp par help karenge: booking, reschedule ya koi sawaal. Messages band karne ke liye STOP likhein.',
    },
  },
];

export const defaultFor = (event: WaEvent) => DEFAULT_TEMPLATES.find(t => t.event === event)!;

/** Fills {{n}} placeholders (for previews and the free-form text inside the 24-hour window). */
export function fillTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
}

export function paramCount(body: string): number {
  return new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1])).size;
}

/** Meta's structural rules, checked before we send a template for review. */
export function validateTemplateBody(body: string): string | null {
  const t = body.trim();
  if (!t) return 'Body is empty';
  if (t.length > 1024) return 'Body is longer than 1024 characters';
  if (/^\{\{\d+\}\}/.test(t) || /\{\{\d+\}\}[.!?।]?$/.test(t)) return 'A parameter cannot be at the very start or end';
  const nums = [...t.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  const distinct = [...new Set(nums)];
  if (distinct.some((n, i) => n !== i + 1)) return 'Parameters must be numbered {{1}}, {{2}}, … in order';
  if (!/STOP/.test(t)) return 'Say how to opt out (e.g. "Reply STOP to opt out")';
  return null;
}

export const isTemplateName = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9_]{1,512}$/.test(x);

// ── Storage ──────────────────────────────────────────────────────────────────

export interface TemplateRow {
  name: string; language: string; purpose: WaEvent | null; variant: ReplyLanguage | null;
  category: string | null; status: string; metaId: string | null; body: string | null;
  paramCount: number; rejectedReason: string | null; updatedAt: number;
}

const toRow = (r: any): TemplateRow => ({
  name: r.name, language: r.language, purpose: r.purpose ?? null, variant: r.variant ?? null,
  category: r.category ?? null, status: r.status, metaId: r.meta_id ?? null, body: r.body ?? null,
  paramCount: Number(r.param_count) || 0, rejectedReason: r.rejected_reason ?? null, updatedAt: Number(r.updated_at) || 0,
});

export async function listTemplates(env: Env): Promise<TemplateRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM wa_templates ORDER BY name, language').all();
  return (results ?? []).map(toRow);
}

/** Which family a name + language belongs to, if it's one of ours (or follows our naming). */
function classify(name: string, language: string): { purpose: WaEvent | null; variant: ReplyLanguage | null } {
  const hinglish = name.endsWith('_hinglish');
  const family = hinglish ? name.slice(0, -'_hinglish'.length) : name;
  const def = DEFAULT_TEMPLATES.find(d => d.family === family);
  const variant: ReplyLanguage | null = hinglish ? 'hi-en' : language.startsWith('hi') ? 'hi' : language.startsWith('en') ? 'en' : null;
  return { purpose: def?.event ?? null, variant };
}

async function upsert(env: Env, t: { name: string; language: string; status: string; category?: string | null; metaId?: string | null; body?: string | null; rejectedReason?: string | null; purpose?: WaEvent | null }) {
  const c = classify(t.name, t.language);
  await env.DB.prepare(`INSERT INTO wa_templates (name, language, purpose, variant, category, status, meta_id, body, param_count, rejected_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (name, language) DO UPDATE SET
        purpose = COALESCE(excluded.purpose, wa_templates.purpose), variant = COALESCE(excluded.variant, wa_templates.variant),
        category = COALESCE(excluded.category, wa_templates.category), status = excluded.status,
        meta_id = COALESCE(excluded.meta_id, wa_templates.meta_id), body = COALESCE(excluded.body, wa_templates.body),
        param_count = CASE WHEN excluded.body IS NULL THEN wa_templates.param_count ELSE excluded.param_count END,
        rejected_reason = excluded.rejected_reason, updated_at = excluded.updated_at`)
    .bind(t.name, t.language, t.purpose ?? c.purpose, c.variant, t.category ?? null, t.status.toUpperCase(), t.metaId ?? null,
      t.body ?? null, t.body ? paramCount(t.body) : 0, t.rejectedReason && t.rejectedReason !== 'NONE' ? t.rejectedReason : null, Date.now())
    .run();
}

/** message_template_status_update webhook: APPROVED / REJECTED / PAUSED / DISABLED … */
export async function applyStatusUpdate(env: Env, v: any): Promise<boolean> {
  const name = v?.message_template_name, language = v?.message_template_language, event = v?.event;
  if (!isTemplateName(name) || typeof language !== 'string' || typeof event !== 'string') return false;
  await upsert(env, { name, language, status: event, metaId: v?.message_template_id ? String(v.message_template_id) : null, rejectedReason: v?.reason ?? null });
  return true;
}

// ── Graph ────────────────────────────────────────────────────────────────────

export const wabaId = (env: Env) => (env.WA_BUSINESS_ACCOUNT_ID ?? '').trim();

export class TemplateError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function requireWaba(env: Env): string {
  const id = wabaId(env);
  if (!/^\d{5,25}$/.test(id)) throw new TemplateError('Set WA_BUSINESS_ACCOUNT_ID (the WhatsApp Business Account id from Meta) first', 409);
  if (!env.WA_ACCESS_TOKEN) throw new TemplateError('Set WA_ACCESS_TOKEN first', 409);
  return id;
}

const graphError = (r: { status: number; data: any }) =>
  new TemplateError(`Meta: ${String(r.data?.error?.error_user_msg ?? r.data?.error?.message ?? `HTTP ${r.status}`).slice(0, 300)}`, 502);

/** Pulls every template on the WABA into wa_templates. Returns how many. */
export async function syncTemplates(env: Env): Promise<number> {
  const waba = requireWaba(env);
  let path: string | null = `${waba}/message_templates?fields=name,language,status,category,id,components,rejected_reason&limit=100`;
  let n = 0;
  for (let page = 0; path && page < 20; page++) {
    const r: { ok: boolean; status: number; data: any } = await graphFetch<any>(env, path, {}, 'list templates');
    if (!r.ok) throw graphError(r);
    for (const t of Array.isArray(r.data?.data) ? r.data.data : []) {
      if (!isTemplateName(t?.name) || typeof t?.language !== 'string') continue;
      const body = (Array.isArray(t.components) ? t.components : []).find((c: any) => c?.type === 'BODY')?.text ?? null;
      await upsert(env, { name: t.name, language: t.language, status: String(t.status ?? 'UNKNOWN'), category: t.category ?? null, metaId: t.id ? String(t.id) : null, body, rejectedReason: t.rejected_reason ?? null });
      n++;
    }
    const next: unknown = r.data?.paging?.next;
    path = typeof next === 'string' && next.startsWith('https://graph.facebook.com/') ? next : null;
  }
  return n;
}

/** Submits one template for review (UTILITY). Meta answers PENDING (or APPROVED for some utility templates). */
export async function createTemplate(env: Env, t: { name: string; variant: ReplyLanguage; body: string; example: string[]; purpose?: WaEvent | null }): Promise<TemplateRow> {
  const waba = requireWaba(env);
  if (!isTemplateName(t.name)) throw new TemplateError('Template names are lower case letters, digits and _');
  const problem = validateTemplateBody(t.body);
  if (problem) throw new TemplateError(problem);
  const params = paramCount(t.body);
  if (t.example.length < params || t.example.slice(0, params).some(e => !e?.trim())) throw new TemplateError(`Give an example for each of the ${params} parameter(s)`);
  const { name, language } = t.variant === 'hi-en' && !t.name.endsWith('_hinglish') ? variantName(t.name, 'hi-en') : { name: t.name, language: t.variant === 'hi' ? 'hi' : 'en' };
  const r = await graphFetch<any>(env, `${waba}/message_templates`, {
    body: {
      name, language, category: 'UTILITY',
      components: [{ type: 'BODY', text: t.body.trim(), ...(params ? { example: { body_text: [t.example.slice(0, params)] } } : {}) }],
    },
  }, `create template ${name}`, 0);
  if (!r.ok) {
    // Already exists in this language: refresh its status instead of failing.
    if (r.data?.error?.error_subcode === 2388024) { await syncTemplates(env).catch(() => 0); }
    else throw graphError(r);
  } else {
    await upsert(env, { name, language, status: String(r.data?.status ?? 'PENDING'), category: r.data?.category ?? 'UTILITY', metaId: r.data?.id ? String(r.data.id) : null, body: t.body.trim(), purpose: t.purpose ?? null });
  }
  const row = await env.DB.prepare('SELECT * FROM wa_templates WHERE name = ? AND language = ?').bind(name, language).first();
  return row ? toRow(row) : { name, language, purpose: t.purpose ?? null, variant: t.variant, category: 'UTILITY', status: 'PENDING', metaId: null, body: t.body, paramCount: params, rejectedReason: null, updatedAt: Date.now() };
}

/** Creates Avery's default template for an event in every language not already on Meta. */
export async function createDefaults(env: Env, event: WaEvent): Promise<TemplateRow[]> {
  const def = defaultFor(event);
  const have = new Set((await listTemplates(env)).map(r => `${r.name}|${r.language}`));
  const out: TemplateRow[] = [];
  for (const variant of VARIANTS) {
    const { name, language } = variantName(def.family, variant);
    if (have.has(`${name}|${language}`)) continue;
    out.push(await createTemplate(env, { name, variant, body: def.body[variant], example: def.example, purpose: event }));
  }
  return out;
}

// ── Event → template family ─────────────────────────────────────────────────

export async function eventChoices(env: Env): Promise<Partial<Record<WaEvent, string>>> {
  try {
    const { results } = await env.DB.prepare('SELECT event, family FROM wa_event_templates').all<{ event: string; family: string }>();
    return Object.fromEntries((results ?? []).filter(r => isEvent(r.event)).map(r => [r.event, r.family]));
  } catch { return {}; }
}

export async function setEventChoice(env: Env, event: WaEvent, family: string | null): Promise<void> {
  if (family === null) {
    await env.DB.prepare('DELETE FROM wa_event_templates WHERE event = ?').bind(event).run();
    return;
  }
  await env.DB.prepare(`INSERT INTO wa_event_templates (event, family, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (event) DO UPDATE SET family = excluded.family, updated_at = excluded.updated_at`).bind(event, family, Date.now()).run();
}

export interface ResolvedTemplate { name: string; language: string; paramCount: number; body: string | null }

/**
 * The APPROVED template to send for an event in a business's language:
 * the chosen family in that language, else its English variant. Null when
 * no family is chosen or no variant is approved yet.
 */
export async function resolveTemplate(env: Env, event: WaEvent, lang: ReplyLanguage): Promise<ResolvedTemplate | null> {
  const family = (await eventChoices(env))[event];
  if (!family) return null;
  const order: ReplyLanguage[] = lang === 'en' ? ['en'] : [lang, 'en'];
  for (const variant of order) {
    const { name, language } = variantName(family, variant);
    const row = await env.DB.prepare("SELECT name, language, param_count, body FROM wa_templates WHERE name = ? AND language = ? AND status = 'APPROVED'")
      .bind(name, language).first<{ name: string; language: string; param_count: number; body: string | null }>().catch(() => null);
    if (row) return { name: row.name, language: row.language, paramCount: Number(row.param_count) || 0, body: row.body };
  }
  return null;
}
