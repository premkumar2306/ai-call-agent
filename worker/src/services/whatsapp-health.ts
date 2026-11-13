// WhatsApp number health for the operator: per mapped number, Meta's quality
// rating, messaging-limit tier, display-name status and verified name (Graph
// GET /{phone_number_id}), when the webhook last delivered a message, and the
// templates' approval states. Refreshed hourly by the cron, on a
// phone_number_quality_update webhook, and on demand. The operator is
// emailed (ADMIN_NOTIFY_EMAIL) once when a number drops to YELLOW or RED.

import type { Env } from '../types';
import { graphFetch, maskId } from './whatsapp-api';
import { sendEmail } from './notify.service';
import { eventChoices, listTemplates, EVENTS, VARIANTS, variantName, type WaEvent } from './whatsapp-templates';

export const HEALTH_FIELDS = 'display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,status';
const BAD = new Set(['YELLOW', 'RED']);

const pnidLastKey = (pnid: string) => `wa:pnid:last:${pnid}`;

/** One KV write per inbound message: when this number last received one. */
export async function notePnidInbound(env: Env, pnid: string, at = Date.now()): Promise<void> {
  await env.CACHE.put(pnidLastKey(pnid), String(at), { expirationTtl: 90 * 86400 });
}

export interface NumberHealth {
  phoneNumberId: string;
  businessType: string | null;
  label: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  status: string | null;
  error: string | null;
  checkedAt: number | null;
  lastMessageAt: number | null;
}

/** Mapped numbers plus the legacy WA_PHONE_NUMBER_ID. */
async function numbers(env: Env): Promise<{ id: string; businessType: string | null; label: string | null }[]> {
  const { results } = await env.DB.prepare('SELECT phone_number_id AS id, business_type AS businessType, label FROM whatsapp_numbers ORDER BY business_type')
    .all<{ id: string; businessType: string; label: string | null }>().catch(() => ({ results: [] as any[] }));
  const out = (results ?? []).map(r => ({ id: String(r.id), businessType: r.businessType ?? null, label: r.label ?? null }));
  const legacy = (env.WA_PHONE_NUMBER_ID ?? '').trim();
  if (legacy && !out.some(n => n.id === legacy)) out.push({ id: legacy, businessType: null, label: 'Default number (WA_PHONE_NUMBER_ID)' });
  return out;
}

/** Re-reads every number from Graph, stores it, and alerts on a drop to YELLOW / RED. */
export async function refreshHealth(env: Env): Promise<{ checked: number; alerts: string[] }> {
  const alerts: string[] = [];
  if (!env.WA_ACCESS_TOKEN) return { checked: 0, alerts };
  const list = await numbers(env);
  for (const n of list.slice(0, 50)) {
    const r = await graphFetch<any>(env, `${encodeURIComponent(n.id)}?fields=${HEALTH_FIELDS}`, {}, `number health ${maskId(n.id)}`, 0);
    const d = r.ok ? r.data ?? {} : {};
    const error = r.ok ? null : String(r.data?.error?.message ?? `HTTP ${r.status}`).slice(0, 200);
    const prev = await env.DB.prepare('SELECT quality_rating, alerted_rating FROM wa_number_health WHERE phone_number_id = ?')
      .bind(n.id).first<{ quality_rating: string | null; alerted_rating: string | null }>().catch(() => null);
    const rating = r.ok ? String(d.quality_rating ?? 'UNKNOWN').toUpperCase() : prev?.quality_rating ?? null;
    let alerted = prev?.alerted_rating ?? null;
    if (rating && BAD.has(rating) && alerted !== rating) {
      const sent = await alertOperator(env, n, rating, d);
      if (sent) { alerted = rating; alerts.push(`${n.id}:${rating}`); }
    } else if (rating === 'GREEN') {
      alerted = null;   // a later drop alerts again
    }
    await env.DB.prepare(`INSERT INTO wa_number_health (phone_number_id, display_phone_number, verified_name, name_status, quality_rating, messaging_limit_tier, status, error, checked_at, alerted_rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (phone_number_id) DO UPDATE SET
          display_phone_number = COALESCE(excluded.display_phone_number, wa_number_health.display_phone_number),
          verified_name = COALESCE(excluded.verified_name, wa_number_health.verified_name),
          name_status = COALESCE(excluded.name_status, wa_number_health.name_status),
          quality_rating = COALESCE(excluded.quality_rating, wa_number_health.quality_rating),
          messaging_limit_tier = COALESCE(excluded.messaging_limit_tier, wa_number_health.messaging_limit_tier),
          status = COALESCE(excluded.status, wa_number_health.status),
          error = excluded.error, checked_at = excluded.checked_at, alerted_rating = excluded.alerted_rating`)
      .bind(n.id, d.display_phone_number ?? null, d.verified_name ?? null, d.name_status ?? null, rating,
        d.messaging_limit_tier ?? null, d.status ?? null, error, Date.now(), alerted)
      .run();
  }
  return { checked: list.length, alerts };
}

async function alertOperator(env: Env, n: { id: string; businessType: string | null; label: string | null }, rating: string, d: any): Promise<boolean> {
  const to = env.ADMIN_NOTIFY_EMAIL;
  if (!to) {
    console.warn(`[wa] number ${maskId(n.id)} quality is ${rating}; set ADMIN_NOTIFY_EMAIL to be emailed about this`);
    return false;
  }
  const name = d.verified_name ?? n.label ?? n.id;
  const what = rating === 'RED'
    ? 'RED: Meta may lower its messaging limit or block it soon. Pause reminders and follow-ups for the businesses on it, and check recent template messages for complaints.'
    : 'YELLOW: customers have been blocking or reporting messages. Check that reminders and follow-ups go only to people who expect them.';
  try {
    await sendEmail(env, to, `WhatsApp number quality ${rating}: ${name}`,
      `The WhatsApp number ${d.display_phone_number ?? ''} (${name}, id ${n.id}${n.businessType ? `, business ${n.businessType}` : ''}) is now ${what}\n\n`
      + `Messaging limit: ${d.messaging_limit_tier ?? 'unknown'}\n\nSee Operator → WhatsApp → Number health, and Meta's WhatsApp Manager → Phone numbers → Insights.\n`);
    return true;
  } catch (e: any) {
    console.error('[wa] quality alert email failed', e?.message || e);
    return false;
  }
}

export interface TemplateSummary {
  event: WaEvent;
  family: string | null;
  variants: { variant: string; name: string; language: string; status: string | null }[];
  ready: boolean;   // the chosen family has at least one APPROVED variant
}

export async function templateSummary(env: Env): Promise<TemplateSummary[]> {
  const [rows, choices] = await Promise.all([listTemplates(env).catch(() => []), eventChoices(env)]);
  return EVENTS.map(event => {
    const family = choices[event] ?? null;
    const variants = family ? VARIANTS.map(variant => {
      const { name, language } = variantName(family, variant);
      return { variant, name, language, status: rows.find(r => r.name === name && r.language === language)?.status ?? null };
    }) : [];
    return { event, family, variants, ready: variants.some(v => v.status === 'APPROVED') };
  });
}

export async function healthView(env: Env): Promise<{ numbers: NumberHealth[]; templates: TemplateSummary[]; webhookFields: string[] }> {
  const list = await numbers(env);
  const out: NumberHealth[] = [];
  for (const n of list) {
    const h = await env.DB.prepare('SELECT * FROM wa_number_health WHERE phone_number_id = ?').bind(n.id).first<any>().catch(() => null);
    const last = await env.CACHE.get(pnidLastKey(n.id)).catch(() => null);
    out.push({
      phoneNumberId: n.id, businessType: n.businessType, label: n.label,
      displayPhoneNumber: h?.display_phone_number ?? null, verifiedName: h?.verified_name ?? null, nameStatus: h?.name_status ?? null,
      qualityRating: h?.quality_rating ?? null, messagingLimitTier: h?.messaging_limit_tier ?? null, status: h?.status ?? null,
      error: h?.error ?? null, checkedAt: h?.checked_at ? Number(h.checked_at) : null, lastMessageAt: last ? Number(last) : null,
    });
  }
  return { numbers: out, templates: await templateSummary(env), webhookFields: ['messages', 'message_template_status_update', 'phone_number_quality_update'] };
}

/** One business's number, for owner Settings → WhatsApp (no ids beyond the display number). */
export async function businessNumber(env: Env, businessType: string): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null } | null> {
  const row = await env.DB.prepare(`SELECT w.phone_number_id AS id, h.display_phone_number, h.verified_name, h.quality_rating
      FROM whatsapp_numbers w LEFT JOIN wa_number_health h ON h.phone_number_id = w.phone_number_id
      WHERE w.business_type = ? ORDER BY w.updated_at DESC LIMIT 1`).bind(businessType).first<any>().catch(() => null);
  if (!row) return null;
  return { displayPhoneNumber: row.display_phone_number ?? null, verifiedName: row.verified_name ?? null, qualityRating: row.quality_rating ?? null };
}
