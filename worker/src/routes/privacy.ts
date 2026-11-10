import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { withAdminKey } from '../middleware';
import { getSector, updatePrivacySettings, type PrivacySettings } from '../services/sector.service';
import {
  DISCLOSURE_MAX_CHARS, defaultDisclosureText, disclosureEnabled, isIndianBusiness, validPrivacyUrl,
} from '../services/disclosure';
import { resolveSubject, exportSubjectData, eraseSubjectData } from '../services/data-rights.service';
import { CONSENT_LOG_MIN_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, validRetentionDays } from '../services/retention.service';

// /admin/privacy/:businessType/* — DPDP settings and data-principal requests.
// Admin-key protected like the rest of /admin. Phone numbers travel in POST
// bodies, never in URLs, so they don't land in access logs.
const privacyAdminRouter = new Hono<HonoEnv>();
privacyAdminRouter.use('*', withAdminKey);

const bt = (c: { req: { param: (k: string) => string | undefined } }) => c.req.param('businessType') ?? '';

// GET settings — the stored values plus what they resolve to.
privacyAdminRouter.get('/:businessType/settings', async (c) => {
  const meta = await getSector(c.env, bt(c));
  if (!meta) return c.json({ success: false, error: 'Unknown business' }, 404);
  return c.json({
    success: true,
    data: {
      aiDisclosure: meta.aiDisclosure ?? null,
      disclosureEffective: disclosureEnabled(meta),
      inIndia: isIndianBusiness(meta),
      disclosureText: meta.disclosureText ?? null,
      defaultDisclosureText: defaultDisclosureText(meta),
      disclosureMaxChars: DISCLOSURE_MAX_CHARS,
      privacyNoticeUrl: meta.privacyNoticeUrl ?? null,
      retentionDays: meta.retentionDays ?? null,
      retentionLimits: { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS },
      consentLogMinDays: CONSENT_LOG_MIN_DAYS,
    },
  });
});

/** Validates a settings body; only keys present are returned. */
export function parsePrivacySettings(body: unknown): { settings: Partial<PrivacySettings> } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<PrivacySettings> = {};
  if ('aiDisclosure' in b) {
    if (b.aiDisclosure !== null && typeof b.aiDisclosure !== 'boolean') return { error: 'aiDisclosure must be true, false or null (automatic)' };
    out.aiDisclosure = b.aiDisclosure as boolean | null;
  }
  if ('disclosureText' in b) {
    if (b.disclosureText !== null && typeof b.disclosureText !== 'string') return { error: 'disclosureText must be a string or null' };
    const t = typeof b.disclosureText === 'string' ? b.disclosureText.trim() : '';
    if (t.length > DISCLOSURE_MAX_CHARS) return { error: `disclosureText is limited to ${DISCLOSURE_MAX_CHARS} characters` };
    out.disclosureText = t || null;
  }
  if ('privacyNoticeUrl' in b) {
    if (b.privacyNoticeUrl === null || b.privacyNoticeUrl === '') out.privacyNoticeUrl = null;
    else {
      const url = validPrivacyUrl(b.privacyNoticeUrl);
      if (!url) return { error: 'privacyNoticeUrl must be an http(s) URL' };
      out.privacyNoticeUrl = url;
    }
  }
  if ('retentionDays' in b) {
    const days = validRetentionDays(b.retentionDays);
    if (days === undefined) return { error: `retentionDays must be ${MIN_RETENTION_DAYS}–${MAX_RETENTION_DAYS} or null (keep)` };
    out.retentionDays = days;
  }
  return { settings: out };
}

// PUT settings — partial: { aiDisclosure?, disclosureText?, privacyNoticeUrl?, retentionDays? }
privacyAdminRouter.put('/:businessType/settings', async (c) => {
  const parsed = parsePrivacySettings(await c.req.json().catch(() => null));
  if ('error' in parsed) return c.json({ success: false, error: parsed.error }, 400);
  const found = await updatePrivacySettings(c.env, bt(c), parsed.settings);
  if (!found) return c.json({ success: false, error: 'Unknown business' }, 404);
  return c.json({ success: true, data: parsed.settings });
});

// POST export { phone } | { customerIdHashed } — everything stored about a caller.
privacyAdminRouter.post('/:businessType/export', async (c) => {
  const businessType = bt(c);
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: 'Unknown business' }, 404);
  const subject = await resolveSubject(c.env, await c.req.json().catch(() => null));
  if ('error' in subject) return c.json({ success: false, error: subject.error }, 400);
  return c.json({ success: true, data: await exportSubjectData(c.env, businessType, subject) });
});

// POST erase { phone | customerIdHashed, confirm: true } — removes the caller's personal data.
privacyAdminRouter.post('/:businessType/erase', async (c) => {
  const businessType = bt(c);
  const meta = await getSector(c.env, businessType);
  if (!meta) return c.json({ success: false, error: 'Unknown business' }, 404);
  const body = await c.req.json().catch(() => null);
  if (body?.confirm !== true) return c.json({ success: false, error: 'Set confirm: true — erasure cannot be undone' }, 400);
  const subject = await resolveSubject(c.env, body);
  if ('error' in subject) return c.json({ success: false, error: subject.error }, 400);
  const summary = await eraseSubjectData(c.env, businessType, subject, meta.timezone);
  return c.json({ success: true, data: summary });
});

// GET notices — recent call-start notice records (audit trail).
privacyAdminRouter.get('/:businessType/notices', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const { results = [] } = await c.env.DB.prepare(
    `SELECT id, channel, call_sid, notice_version, played_at, heard_fully, customer_id_hashed IS NULL AS erased
     FROM consent_records WHERE business_type = ? ORDER BY played_at DESC LIMIT ?`,
  ).bind(bt(c), limit).all();
  return c.json({ success: true, data: results });
});

// GET requests — export/erasure requests handled for this business.
privacyAdminRouter.get('/:businessType/requests', async (c) => {
  const { results = [] } = await c.env.DB.prepare(
    'SELECT id, kind, summary, created_at FROM data_requests WHERE business_type = ? ORDER BY created_at DESC LIMIT 100',
  ).bind(bt(c)).all();
  return c.json({ success: true, data: results });
});

export { privacyAdminRouter };
