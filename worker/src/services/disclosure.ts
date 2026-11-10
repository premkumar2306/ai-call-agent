import type { Env, SectorMeta } from '../types';

// Call-start notice: tells the caller they are talking to an AI assistant
// and that the call is transcribed, and points to the business's privacy
// notice. Supports a business's notice duties under India's Digital Personal
// Data Protection Act 2023 (s.5) and DPDP Rules 2025 (r.3), and the AI-call
// disclosure TRAI has consulted on. It does not by itself make a business
// compliant — see docs/compliance-india.md.
//
// Off for existing businesses unless switched on: sectors.ai_disclosure NULL
// means "automatic", which is on only for businesses in India.

export const DEFAULT_DISCLOSURE_TEXT =
  "Just so you know, you're speaking with an AI assistant, and this call is transcribed so we can help you. " +
  'Our privacy notice is linked in any text we send you.';

// Upper bound on a custom notice, so a pasted policy doesn't become a
// minute of audio before the caller can speak.
export const DISCLOSURE_MAX_CHARS = 400;

type CountryAware = SectorMeta & { countryCode?: string | null };

/**
 * Whether a business is in India. Reads `countryCode` once the locale
 * workstream adds it to sectors; until then the business's timezone or
 * currency decides.
 */
export function isIndianBusiness(meta: CountryAware | null | undefined): boolean {
  if (!meta) return false;
  if (meta.countryCode) return meta.countryCode.toUpperCase() === 'IN';
  return meta.timezone === 'Asia/Kolkata' || meta.timezone === 'Asia/Calcutta' || meta.currency?.toUpperCase() === 'INR';
}

/** The explicit per-business setting wins; otherwise on only in India. */
export function disclosureEnabled(meta: CountryAware | null | undefined): boolean {
  if (!meta) return false;
  if (typeof meta.aiDisclosure === 'boolean') return meta.aiDisclosure;
  return isIndianBusiness(meta);
}

export function disclosureText(meta: SectorMeta | null | undefined): string {
  const custom = meta?.disclosureText?.trim();
  return custom ? custom.slice(0, DISCLOSURE_MAX_CHARS) : DEFAULT_DISCLOSURE_TEXT;
}

/** The text to speak at call start, or null when the notice is off. */
export function callStartNotice(meta: CountryAware | null | undefined): string | null {
  return disclosureEnabled(meta) ? disclosureText(meta) : null;
}

/**
 * Appended to texts sent to the caller (booking confirmations, the first
 * WhatsApp reply) while the notice is on and a privacy notice URL is set.
 */
export function privacyLinkSuffix(meta: CountryAware | null | undefined): string {
  if (!disclosureEnabled(meta) || !meta?.privacyNoticeUrl) return '';
  return ` Privacy notice: ${meta.privacyNoticeUrl}`;
}

/** First WhatsApp reply of a conversation: notice + link, on its own paragraph. */
export function whatsappNotice(meta: CountryAware | null | undefined): string | null {
  if (!disclosureEnabled(meta)) return null;
  const base = meta?.disclosureText?.trim()
    ? disclosureText(meta)
    : "You're chatting with an AI assistant. Messages are stored so we can help you.";
  return `${base}${privacyLinkSuffix(meta)}`.trim();
}

/** Short stable id of a notice's wording, so the audit trail shows which text was given. */
export async function noticeVersion(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface ConsentRecordInput {
  businessType: string;
  channel: 'voice' | 'whatsapp';
  callSid?: string | null;
  customerIdHashed?: string | null;
  noticeText: string;
  playedAt: Date;
  heardFully?: boolean | null;
}

/** Records that the notice was given (consent_records). Never throws. */
export async function recordConsent(env: Env, rec: ConsentRecordInput): Promise<void> {
  try {
    const sec = (d: Date) => Math.floor(d.getTime() / 1000);
    await env.DB.prepare(
      `INSERT INTO consent_records (id, business_type, channel, call_sid, customer_id_hashed, notice_version, notice_text, played_at, heard_fully, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), rec.businessType, rec.channel, rec.callSid ?? null, rec.customerIdHashed ?? null,
      await noticeVersion(rec.noticeText), rec.noticeText, sec(rec.playedAt),
      rec.heardFully === undefined || rec.heardFully === null ? null : rec.heardFully ? 1 : 0,
      sec(new Date()),
    ).run();
  } catch (e: any) {
    console.error('[consent] record failed', e?.message || e);
  }
}

/** Accepts only http(s) URLs for the privacy notice link. */
export function validPrivacyUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
