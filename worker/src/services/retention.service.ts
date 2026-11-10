import type { Env } from '../types';

// Per-business retention (sectors.retention_days), enforced daily by the
// Cron Trigger in wrangler.toml (see `scheduled` in index.ts).
//
//   transcripts    deleted once untouched for retention_days (updated_at, so
//                  an ongoing WhatsApp thread isn't cut mid-conversation)
//   call_messages  deleted retention_days after they were left
//   consent_records kept for max(retention_days, CONSENT_LOG_MIN_DAYS): they
//                  are the audit trail that the notice was given
//
// Avery stores no call audio, so there are no recordings to delete. Live
// call/chat history in KV already expires within 24 hours. Bookings are
// business records and are not touched (erase a caller's personal data on
// request with /admin/privacy/:business/erase).
//
// NULL retention_days (the default, and the existing US business) = keep.

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
// DPDP Rules 2025 r.8(3) asks data fiduciaries to keep personal data,
// traffic data and processing logs for at least a year for the purposes in
// its Seventh Schedule; the notice log is kept at least that long.
export const CONSENT_LOG_MIN_DAYS = 365;

const DAY = 86_400;

export function validRetentionDays(v: unknown): number | null | undefined {
  if (v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isInteger(n) && (n as number) >= MIN_RETENTION_DAYS && (n as number) <= MAX_RETENTION_DAYS ? n as number : undefined;
}

/** Unix-seconds cutoffs: rows older than these are deleted. */
export function retentionCutoffs(retentionDays: number, now: Date): { data: number; consent: number } {
  const nowSec = Math.floor(now.getTime() / 1000);
  return {
    data: nowSec - retentionDays * DAY,
    consent: nowSec - Math.max(retentionDays, CONSENT_LOG_MIN_DAYS) * DAY,
  };
}

export interface RetentionResult {
  businessType: string;
  retentionDays: number;
  transcripts: number;
  messages: number;
  noticeRecords: number;
}

export async function applyRetention(env: Env, now = new Date()): Promise<RetentionResult[]> {
  const { results: sectors = [] } = await env.DB.prepare(
    'SELECT key, retention_days FROM sectors WHERE retention_days IS NOT NULL AND retention_days > 0',
  ).all<{ key: string; retention_days: number }>();
  const out: RetentionResult[] = [];
  for (const s of sectors) {
    const cut = retentionCutoffs(s.retention_days, now);
    try {
      const [t, m, c] = await env.DB.batch([
        env.DB.prepare('DELETE FROM transcripts WHERE business_type = ? AND updated_at < ?').bind(s.key, cut.data),
        env.DB.prepare('DELETE FROM call_messages WHERE business_type = ? AND created_at < ?').bind(s.key, cut.data),
        env.DB.prepare('DELETE FROM consent_records WHERE business_type = ? AND played_at < ?').bind(s.key, cut.consent),
      ]);
      const r = {
        businessType: s.key, retentionDays: s.retention_days,
        transcripts: t.meta?.changes ?? 0, messages: m.meta?.changes ?? 0, noticeRecords: c.meta?.changes ?? 0,
      };
      out.push(r);
      console.log(JSON.stringify({ level: 'info', msg: 'retention', ...r }));
    } catch (e: any) {
      // One business failing must not stop the others.
      console.error(JSON.stringify({ level: 'error', msg: 'retention failed', businessType: s.key, error: e?.message || String(e) }));
    }
  }
  return out;
}
