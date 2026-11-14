import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { hitLimit, withAdminKey } from '../middleware';
import type { Env } from '../types';
import { getIntegration, redact, runCheck } from '../services/integrations';
import { businessForNumber, normalizeE164 } from '../services/phone-numbers';

// Operator: GET /admin/plivo/verify — the live Plivo set-up, read-only.
// Checks the account with the real keys (the Integrations check), lists the
// account's numbers with their Application's answer/hangup URLs, and says
// which Avery business each number reaches. Never returns a secret value,
// never places a call or spends money. Used by `npm run plivo:verify`.

export const plivoAdminRouter = new Hono<HonoEnv>();

const TIMEOUT_MS = 8_000;
const MAX_NUMBERS = 20;

export interface PlivoNumberReport {
  number: string;                       // E.164
  voiceEnabled: boolean | null;
  businessType: string | null;          // mapped in Settings → Phone numbers
  reachesDefault: boolean;              // unmapped, but PLIVO_DEFAULT_BUSINESS_TYPE answers it
  application: { id: string; name: string | null; answerUrl: string | null; answerMethod: string | null; hangupUrl: string | null } | null;
  answerOk: boolean;
  hangupOk: boolean;
}

export interface PlivoVerifyReport {
  settings: Record<'PLIVO_AUTH_ID' | 'PLIVO_AUTH_TOKEN' | 'PLIVO_WEBHOOK_URL' | 'PLIVO_DEFAULT_BUSINESS_TYPE', boolean>;
  account: { ok: boolean | null; error?: string; note?: string };
  expected: { answerUrl: string | null; hangupUrl: string | null };
  numbers: PlivoNumberReport[];
  numbersError?: string;
}

const appIdFrom = (uri: unknown): string | null => {
  const m = typeof uri === 'string' ? uri.match(/\/Application\/([^/]+)\/?$/) : null;
  return m ? m[1] : null;
};
const sameUrl = (a: string | null, b: string | null) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

async function plivoGet(env: Env, path: string): Promise<any> {
  const id = env.PLIVO_AUTH_ID ?? '';
  const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(id)}${path}`, {
    headers: { Authorization: `Basic ${btoa(`${id}:${env.PLIVO_AUTH_TOKEN ?? ''}`)}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(text);
}

export async function plivoVerify(env: Env): Promise<PlivoVerifyReport> {
  const base = env.PLIVO_WEBHOOK_URL?.replace(/\/+$/, '') ?? null;
  const report: PlivoVerifyReport = {
    settings: {
      PLIVO_AUTH_ID: !!env.PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN: !!env.PLIVO_AUTH_TOKEN,
      PLIVO_WEBHOOK_URL: !!env.PLIVO_WEBHOOK_URL, PLIVO_DEFAULT_BUSINESS_TYPE: !!env.PLIVO_DEFAULT_BUSINESS_TYPE,
    },
    account: { ok: null },
    expected: { answerUrl: base && `${base}/plivo/answer`, hangupUrl: base && `${base}/plivo/hangup` },
    numbers: [],
  };
  const check = await runCheck(env, getIntegration('plivo')!);
  report.account = { ok: check.ok, ...(check.error ? { error: check.error } : {}), ...(check.note ? { note: check.note } : {}) };
  if (check.ok !== true) return report;

  try {
    const list = await plivoGet(env, `/Number/?limit=${MAX_NUMBERS}`);
    const apps = new Map<string, PlivoNumberReport['application']>();
    for (const n of Array.isArray(list?.objects) ? list.objects : []) {
      const number = normalizeE164(String(n.number ?? ''), '91');
      if (!number) continue;
      const appId = appIdFrom(n.application);
      if (appId && !apps.has(appId)) {
        try {
          const a = await plivoGet(env, `/Application/${encodeURIComponent(appId)}/`);
          apps.set(appId, {
            id: appId, name: a.app_name ?? null, answerUrl: a.answer_url ?? null,
            answerMethod: a.answer_method ?? null, hangupUrl: a.hangup_url ?? null,
          });
        } catch {
          apps.set(appId, { id: appId, name: null, answerUrl: null, answerMethod: null, hangupUrl: null });
        }
      }
      const application = appId ? apps.get(appId) ?? null : null;
      const businessType = await businessForNumber(env, 'plivo', number);
      report.numbers.push({
        number,
        voiceEnabled: typeof n.voice_enabled === 'boolean' ? n.voice_enabled : null,
        businessType,
        reachesDefault: !businessType && !!env.PLIVO_DEFAULT_BUSINESS_TYPE,
        application,
        answerOk: sameUrl(application?.answerUrl ?? null, report.expected.answerUrl) && (application?.answerMethod ?? 'POST').toUpperCase() === 'POST',
        // Plivo defaults the hangup URL to the answer URL, which /plivo/answer also acknowledges.
        hangupOk: sameUrl(application?.hangupUrl ?? null, report.expected.hangupUrl)
          || sameUrl(application?.hangupUrl || application?.answerUrl || null, report.expected.answerUrl),
      });
    }
  } catch (e: any) {
    report.numbersError = redact(env, `Could not list numbers: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message || e}`);
  }
  return report;
}

plivoAdminRouter.get('/verify', withAdminKey, async (c) => {
  if (await hitLimit(c.env, 'rl:plivo:verify', 6, 60)) {
    return c.json({ success: false, error: 'Too many checks. Please wait a minute.' }, 429);
  }
  return c.json({ success: true, data: await plivoVerify(c.env) });
});
