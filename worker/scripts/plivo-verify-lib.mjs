// Pure rendering for scripts/plivo-verify.mjs (unit-tested in test/plivo-verify.test.ts).
// Input is what the Worker already redacted; nothing here can see a secret.

const SECRET_FIX = name => `npx wrangler secret put ${name}`;

/**
 * @param {{ workerUrl: string, health: { ok: boolean, status: number|string },
 *           unsigned: { status: number|string }, report: any|null, reportError?: string }} r
 * @returns {{ lines: string[], ok: boolean, next: string[] }}
 */
export function renderPlivoVerify({ workerUrl, health, unsigned, report, reportError }) {
  const lines = [];
  const next = [];
  let ok = true;
  const item = (pass, text, fix) => {
    lines.push(`${pass ? '✓' : '✗'} ${text}`);
    if (!pass) { ok = false; if (fix) next.push(fix); }
  };
  const want = `${workerUrl}/plivo/answer`;
  const wantHangup = `${workerUrl}/plivo/hangup`;

  item(health.ok, `Worker is up (${workerUrl}/health → ${health.status})`, 'Deploy the Worker, or check WORKER_URL.');
  item(unsigned.status === 403, `Unsigned POST /plivo/answer is rejected (→ ${unsigned.status})`,
    'The Worker accepted an unsigned Plivo webhook: set PLIVO_AUTH_TOKEN and PLIVO_WEBHOOK_URL, and NODE_ENV="production".');

  if (!report) {
    item(false, `Operator report GET /admin/plivo/verify: ${reportError ?? 'unavailable'}`, 'Check ADMIN_KEY, and that this branch is deployed.');
    return { lines, ok, next };
  }
  for (const [name, set] of Object.entries(report.settings)) {
    if (name === 'PLIVO_DEFAULT_BUSINESS_TYPE') {
      lines.push(`${set ? '✓' : '·'} ${name} ${set ? 'is set (answers unmapped Plivo numbers)' : 'not set (optional: unmapped numbers hear "not configured")'}`);
      continue;
    }
    item(set, `${name} is ${set ? 'set' : 'missing'}`, set ? null : SECRET_FIX(name));
  }
  if (report.expected.answerUrl) {
    item(report.expected.answerUrl.replace(/\/+$/, '') === want, `PLIVO_WEBHOOK_URL matches WORKER_URL (Plivo signs ${report.expected.answerUrl})`,
      `Set PLIVO_WEBHOOK_URL to ${workerUrl} (${SECRET_FIX('PLIVO_WEBHOOK_URL')}); signatures are checked against it.`);
  }
  const a = report.account;
  item(a.ok === true, `Plivo account check (GET Account with the real keys): ${a.ok === true ? 'Working' : a.ok === false ? `Failing — ${a.error ?? 'error'}` : `not checked — ${a.note ?? ''}`}`,
    a.ok === false ? `Plivo refused the keys: re-copy Auth ID and Auth Token from console.plivo.com (${SECRET_FIX('PLIVO_AUTH_ID')}, ${SECRET_FIX('PLIVO_AUTH_TOKEN')}).` : null);
  if (a.ok !== true) return { lines, ok, next };

  if (report.numbersError) item(false, report.numbersError, 'Retry in a minute; check the Plivo account status.');
  else if (!report.numbers.length) item(false, 'The Plivo account has no phone numbers', 'Buy or port an Indian number in Plivo (Phone Numbers → Buy), see docs/plivo-setup.md.');

  for (const n of report.numbers) {
    const app = n.application;
    lines.push(`  ${n.number}${app ? ` → app "${app.name ?? app.id}"` : ' → no application'}`);
    lines.push(`      answer URL: ${app?.answerUrl ?? '(none)'}${app?.answerMethod ? ` [${app.answerMethod}]` : ''}`);
    lines.push(`      hangup URL: ${app?.hangupUrl || '(defaults to the answer URL)'}`);
    if (n.voiceEnabled === false) item(false, `  ${n.number} is not voice-enabled`, `Use a voice-enabled number instead of ${n.number}.`);
    item(n.answerOk, `  ${n.number} answer URL points at ${want}`, app
      ? `Plivo console → Voice → Applications → "${app.name ?? app.id}": Answer URL = ${want}, method POST.`
      : `Plivo console → Phone Numbers → ${n.number}: Application Type "XML Application", pick the Avery application (Answer URL ${want}, POST).`);
    item(n.hangupOk, `  ${n.number} hangup URL is acknowledged`, app
      ? `Plivo console → Voice → Applications → "${app.name ?? app.id}": Hangup URL = ${wantHangup}, method POST.` : null);
    item(!!n.businessType || n.reachesDefault, `  ${n.number} is mapped to a business${n.businessType ? ` (${n.businessType})` : n.reachesDefault ? ' (via PLIVO_DEFAULT_BUSINESS_TYPE)' : ''}`,
      `Avery admin → Settings → Phone numbers: add ${n.number}, provider Plivo, and pick the business.`);
  }
  if (ok) next.push('Make the live test calls in docs/plivo-setup.md (English and Hindi: book, cancel, transfer, hang up early).');
  return { lines, ok, next };
}

/** Removes any of these values from text (belt and braces: the Worker never sends one). */
export function scrubAll(text, values) {
  let t = text;
  for (const v of values) if (v && v.length >= 6) t = t.split(v).join('[redacted]');
  return t;
}
