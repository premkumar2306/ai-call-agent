// Pure helpers for scripts/whatsapp-setup.mjs (unit-tested in test/whatsapp-setup.test.ts).
// No network, no process access: everything here is a plain function.

export const GRAPH_VERSION = 'v24.0';   // keep in step with src/services/whatsapp-api.ts

/** Flags: --dry-run, --map <business>, --phone-number-id <id>, --test-to <number>, --register-pin <pin>, --show-verify-token, --env-file <path>, --help */
export function parseArgs(argv) {
  const out = { dryRun: false, showVerifyToken: false, help: false };
  const takes = { '--map': 'map', '--phone-number-id': 'phoneNumberId', '--test-to': 'testTo', '--register-pin': 'registerPin', '--env-file': 'envFile', '--label': 'label' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--show-verify-token') out.showVerifyToken = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (takes[flag]) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      out[takes[flag]] = v;
    } else throw new Error(`unknown option ${a} (try --help)`);
  }
  return out;
}

/** KEY=value lines of a .env file; # comments, optional quotes and `export `. */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** The environment wins over the .env file, so a one-off `WA_X=… node …` overrides it. */
export function mergeConfig(dotenv, env) {
  const pick = k => (env[k] ?? dotenv[k] ?? '').trim() || undefined;
  return {
    accessToken: pick('WA_ACCESS_TOKEN'),
    wabaId: pick('WA_WABA_ID'),
    verifyToken: pick('WA_VERIFY_TOKEN'),
    phoneNumberId: pick('WA_PHONE_NUMBER_ID'),
    workerUrl: pick('WORKER_URL'),
    adminKey: pick('ADMIN_KEY') ?? pick('ADMIN_SECRET'),
    business: pick('WA_BUSINESS'),
    testTo: pick('WA_TEST_TO'),
  };
}

/** A secret shown as its first two and last two characters. */
export function mask(secret) {
  if (!secret) return '(not set)';
  return secret.length <= 8 ? '•'.repeat(secret.length) : `${secret.slice(0, 2)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/** Removes any of `secrets` (and Meta token shapes) from a string before it is printed. */
export function redact(s, ...secrets) {
  let out = String(s);
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join('[redacted]');
  return out.replace(/\bEAA[A-Za-z0-9]{20,}/g, '[redacted]').replace(/(access_token=)[^&\s"]+/gi, '$1[redacted]');
}

/** https://<worker>/whatsapp/webhook from a Worker URL with or without scheme or trailing slash. */
export function webhookUrl(workerUrl) {
  if (!workerUrl) throw new Error('WORKER_URL is not set');
  const withScheme = /^https?:\/\//i.test(workerUrl) ? workerUrl : `https://${workerUrl}`;
  const u = new URL(withScheme);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Meta only calls https:// webhook URLs');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/whatsapp/webhook`;
}

/** Digits only, as the Cloud API wants `to`; refuses something that can't be a phone number. */
export function normalizeRecipient(number) {
  const digits = String(number ?? '').replace(/[\s()+-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) throw new Error(`"${number}" is not a phone number with country code (e.g. +91 98450 12345)`);
  return digits;
}

/** Table rows and plain-language warnings for the WABA's phone numbers. */
export function describePhoneNumbers(numbers) {
  const rows = (numbers ?? []).map(n => ({
    phone_number_id: n.id,
    number: n.display_phone_number ?? '?',
    verified_name: n.verified_name ?? '?',
    quality: n.quality_rating ?? 'UNKNOWN',
    status: n.status ?? n.code_verification_status ?? 'UNKNOWN',
    name_status: n.name_status ?? '',
  }));
  const warnings = [];
  for (const r of rows) {
    if (/PENDING|UNVERIFIED|NOT_VERIFIED|EXPIRED/i.test(r.status)) warnings.push(`${r.number}: status ${r.status} — finish verification in WhatsApp Manager (or register it with --register-pin) before it can send.`);
    if (r.status === 'DISCONNECTED' || r.status === 'BANNED' || r.status === 'FLAGGED') warnings.push(`${r.number}: status ${r.status} — check WhatsApp Manager → Phone numbers.`);
    if (r.quality === 'RED') warnings.push(`${r.number}: quality RED — Meta may limit this number. Check recent customer blocks/reports.`);
    if (/DECLINED|REJECTED/i.test(r.name_status)) warnings.push(`${r.number}: display name ${r.name_status} — edit it in WhatsApp Manager so it matches your business.`);
  }
  return { rows, warnings };
}

/** Whether registering via the API is needed: only for numbers that aren't connected yet. */
export function needsRegistration(number) {
  return !!number && !['CONNECTED', 'MIGRATED'].includes(String(number.status ?? '').toUpperCase());
}

/** Picks the number to work with: the one asked for, else the only one. */
export function choosePhoneNumber(rows, wanted) {
  if (wanted) {
    const hit = rows.find(r => r.phone_number_id === wanted);
    if (!hit) throw new Error(`phone_number_id ${wanted} is not in this WhatsApp Business Account`);
    return hit;
  }
  if (rows.length === 1) return rows[0];
  return null;
}

/** 'create' | 'update' (mapped to another business) | 'same' (nothing to do). */
export function planMapping(existing, phoneNumberId, business) {
  const row = (existing ?? []).find(r => (r.phoneNumberId ?? r.phone_number_id) === phoneNumberId);
  if (!row) return 'create';
  return (row.businessType ?? row.business_type) === business ? 'same' : 'update';
}

/** One readable line for a Graph error, with hints for the usual causes. */
export function explainGraphError(status, body) {
  const e = body?.error ?? {};
  const code = Number(e.code);
  const hint =
    code === 190 ? 'The access token is invalid or expired. Create a System User token (it does not expire) and set WA_ACCESS_TOKEN again.'
    : code === 200 || code === 10 ? 'The token lacks permission. Give the System User the WhatsApp account with whatsapp_business_management and whatsapp_business_messaging.'
    : code === 100 ? 'Meta did not recognise an id. Check WA_WABA_ID (the WhatsApp Business Account id, not the app id or phone_number_id).'
    : code === 131030 ? 'This recipient is not on the test number’s allowed list. Add it in the app’s WhatsApp → API Setup, or use your real number.'
    : code === 133010 ? 'The number is not registered with the Cloud API yet. Run again with --register-pin <6 digits>.'
    : code === 132001 ? 'The template does not exist in this language. hello_world exists only in en_US.'
    : '';
  return `HTTP ${status}${e.code ? `, code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}` : ''}: ${e.message ?? 'request failed'}${hint ? `\n    → ${hint}` : ''}`;
}
