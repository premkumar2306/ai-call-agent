#!/usr/bin/env node
// WhatsApp setup check for Avery. Run it on your own computer, with your own
// Meta credentials; see docs/whatsapp-setup.md. It never prints a secret.
//
//   cd worker
//   node scripts/whatsapp-setup.mjs --dry-run                 # look, change nothing
//   node scripts/whatsapp-setup.mjs                           # check + subscribe the app to the WABA
//   node scripts/whatsapp-setup.mjs --map my_clinic           # also map the number to a business
//   node scripts/whatsapp-setup.mjs --test-to +919845012345   # also send hello_world to your phone
//
// Values come from the environment or a local .env file (worker/.env, never
// committed; .gitignore covers it):
//   WA_ACCESS_TOKEN   System User token (whatsapp_business_messaging + whatsapp_business_management)
//   WA_WABA_ID        WhatsApp Business Account id (WhatsApp Manager → Account tools, or the app's API Setup)
//   WA_VERIFY_TOKEN   the same random string you set with `wrangler secret put WA_VERIFY_TOKEN`
//   WORKER_URL        e.g. https://ai-call-agent.<you>.workers.dev
//   WA_PHONE_NUMBER_ID (optional) the number to use when the account has several
//   ADMIN_KEY         (optional, for --map) the Worker's ADMIN_SECRET
//   WA_BUSINESS / WA_TEST_TO (optional) defaults for --map / --test-to
//
// Every step is safe to repeat.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  choosePhoneNumber, describePhoneNumbers, explainGraphError, GRAPH_VERSION, mask, mergeConfig, needsRegistration,
  normalizeRecipient, parseArgs, parseDotEnv, planMapping, redact, webhookUrl,
} from './whatsapp-setup-lib.mjs';

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n');

let args;
try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
if (args.help) { console.log(HELP); process.exit(0); }

const here = dirname(fileURLToPath(import.meta.url));
const envFile = args.envFile ?? [join(here, '..', '.env'), join(process.cwd(), '.env')].find(existsSync);
const dotenv = envFile && existsSync(envFile) ? parseDotEnv(readFileSync(envFile, 'utf8')) : {};
const cfg = mergeConfig(dotenv, process.env);
const secrets = [cfg.accessToken, cfg.verifyToken, cfg.adminKey];
const say = (...a) => console.log(redact(a.join(' '), ...secrets));
const ok = s => say(`  ✓ ${s}`), warn = s => say(`  ! ${s}`), fail = s => say(`  ✗ ${s}`);
const next = [];
let failed = false;

// Tests only: point Graph at a local stand-in (http://127.0.0.1 / localhost, nothing else).
const GRAPH = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(process.env.WA_SETUP_GRAPH_BASE ?? '') ? process.env.WA_SETUP_GRAPH_BASE : 'https://graph.facebook.com';

async function graph(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}/${GRAPH_VERSION}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

say(`WhatsApp setup${args.dryRun ? ' (dry run: nothing will be changed)' : ''}`);
say(`  config: ${envFile ? `.env at ${envFile} + environment` : 'environment only'}; WA_ACCESS_TOKEN ${mask(cfg.accessToken)}, WA_WABA_ID ${cfg.wabaId ?? '(not set)'}`);

// a. Token and phone numbers.
say('\n1. Access token and phone numbers');
let chosen = null;
if (!cfg.accessToken || !cfg.wabaId) {
  fail('WA_ACCESS_TOKEN and WA_WABA_ID are both needed. Put them in worker/.env (see docs/whatsapp-setup.md, steps 4–5).');
  process.exit(1);
}
const waba = await graph(`${encodeURIComponent(cfg.wabaId)}?fields=id,name,currency,timezone_id,message_template_namespace`);
if (!waba.ok) {
  fail(`Could not read the WhatsApp Business Account: ${explainGraphError(waba.status, waba.json)}`);
  process.exit(1);
}
ok(`token works; account "${waba.json.name ?? cfg.wabaId}" (${waba.json.id})`);
const nums = await graph(`${encodeURIComponent(cfg.wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status,code_verification_status,name_status,platform_type`);
if (!nums.ok) { fail(`Could not list phone numbers: ${explainGraphError(nums.status, nums.json)}`); process.exit(1); }
const { rows, warnings } = describePhoneNumbers(nums.json.data);
if (!rows.length) {
  fail('This account has no phone numbers yet. Add one in WhatsApp Manager → Phone numbers (guide step 3).');
  process.exit(1);
}
console.table(rows);
warnings.forEach(warn);
try {
  chosen = choosePhoneNumber(rows, args.phoneNumberId ?? cfg.phoneNumberId);
} catch (e) { fail(e.message); process.exit(1); }
if (!chosen) {
  warn(`Several numbers: pick one with --phone-number-id <id> (or WA_PHONE_NUMBER_ID). Steps 4–6 are skipped.`);
} else {
  ok(`using ${chosen.number} (phone_number_id ${chosen.phone_number_id})`);
  if (cfg.phoneNumberId && cfg.phoneNumberId !== chosen.phone_number_id) warn('WA_PHONE_NUMBER_ID in your .env is a different number.');
  if (!cfg.phoneNumberId) next.push(`Set the Worker's default number: npx wrangler secret put WA_PHONE_NUMBER_ID  (value ${chosen.phone_number_id})`);
}

// Optional: register a number that isn't connected yet (two-step verification PIN).
if (chosen && args.registerPin) {
  const raw = (nums.json.data ?? []).find(n => n.id === chosen.phone_number_id);
  if (!needsRegistration(raw)) ok('number is already registered with the Cloud API');
  else if (!/^\d{6}$/.test(args.registerPin)) fail('--register-pin must be 6 digits');
  else if (args.dryRun) say(`  would register ${chosen.number} with the Cloud API`);
  else {
    const r = await graph(`${chosen.phone_number_id}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin: args.registerPin } });
    r.ok ? ok('number registered with the Cloud API') : (fail(`register failed: ${explainGraphError(r.status, r.json)}`), failed = true);
  }
}

// b. Subscribe the app to the WABA, so its webhooks reach the Worker.
say('\n2. App subscription to the WhatsApp Business Account');
const subs = await graph(`${encodeURIComponent(cfg.wabaId)}/subscribed_apps`);
const apps = subs.ok ? (subs.json.data ?? []).map(a => a.whatsapp_business_api_data?.name ?? a.name ?? a.id).filter(Boolean) : [];
if (apps.length) say(`  currently subscribed: ${apps.join(', ')}`);
if (args.dryRun) say('  would POST subscribed_apps (safe to repeat)');
else {
  const r = await graph(`${encodeURIComponent(cfg.wabaId)}/subscribed_apps`, { method: 'POST' });
  r.ok && r.json.success !== false ? ok('app is subscribed (messages will be delivered to its webhook)') : (fail(`subscribe failed: ${explainGraphError(r.status, r.json)}`), failed = true);
}

// c. Webhook URL and verify token; check the Worker answers the handshake.
say('\n3. Webhook');
let hook = null;
try { hook = webhookUrl(cfg.workerUrl); } catch (e) { fail(`${e.message}. Set WORKER_URL in worker/.env.`); failed = true; }
if (hook) {
  say('  In developers.facebook.com → your app → WhatsApp → Configuration → Webhook → Edit:');
  say(`    Callback URL:  ${hook}`);
  if (args.showVerifyToken && cfg.verifyToken) console.log(`    Verify token:  ${cfg.verifyToken}`);   // asked for explicitly
  else say(`    Verify token:  the value of WA_VERIFY_TOKEN ${mask(cfg.verifyToken)} (run with --show-verify-token to print it)`);
  say('  Then under Webhook fields, subscribe to "messages".');
  if (!cfg.verifyToken) { fail('WA_VERIFY_TOKEN is not set here, so the handshake cannot be checked.'); failed = true; }
  else {
    const challenge = randomBytes(6).toString('hex');
    const q = t => `${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(t)}&hub.challenge=${challenge}`;
    try {
      const good = await fetch(q(cfg.verifyToken), { signal: AbortSignal.timeout(15000) });
      const text = await good.text();
      const bad = await fetch(q(`wrong-${challenge}`), { signal: AbortSignal.timeout(15000) });
      if (good.status === 200 && text === challenge && bad.status === 403) ok('the Worker answers Meta\'s verification correctly');
      else if (good.status === 403) { fail('the Worker refused the verify token: WA_VERIFY_TOKEN in the Worker differs from the one here. Run: npx wrangler secret put WA_VERIFY_TOKEN'); failed = true; }
      else { fail(`unexpected answer: HTTP ${good.status}${bad.status !== 403 ? `, wrong token gave ${bad.status}` : ''}. Is WORKER_URL right and the Worker deployed?`); failed = true; }
    } catch (e) { fail(`could not reach ${hook}: ${e.message}`); failed = true; }
  }
}

// d. Map the number to a business (Operator → WhatsApp does the same).
const business = args.map ?? cfg.business;
if (business) {
  say('\n4. Number → business');
  if (!chosen) warn('no number chosen; skipped');
  else if (!cfg.adminKey || !hook) { fail('needs ADMIN_KEY and WORKER_URL'); failed = true; }
  else {
    const base = hook.replace(/\/whatsapp\/webhook$/, '');
    const headers = { 'X-Admin-Key': cfg.adminKey, 'Content-Type': 'application/json' };
    const list = await fetch(`${base}/admin/whatsapp-numbers`, { headers }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).catch(e => ({ error: e.message }));
    if (list.error) { fail(`could not read the mapping (${list.error}). Is ADMIN_KEY the Worker's ADMIN_SECRET?`); failed = true; }
    else {
      const plan = planMapping(list.data, chosen.phone_number_id, business);
      if (plan === 'same') ok(`already mapped to ${business}`);
      else if (args.dryRun) say(`  would ${plan === 'create' ? 'map' : 're-map'} ${chosen.phone_number_id} → ${business}`);
      else {
        const r = await fetch(`${base}/admin/whatsapp-numbers`, { method: 'PUT', headers, body: JSON.stringify({ phoneNumberId: chosen.phone_number_id, businessType: business, label: args.label ?? chosen.verified_name }) });
        r.ok ? ok(`${chosen.number} now answers as ${business}`) : (fail(`mapping failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`), failed = true);
      }
    }
  }
} else next.push('Map the number to a business: Operator → WhatsApp in the app, or run again with --map <business_key>.');

// e. Test message: hello_world (a template, so it works outside the 24-hour window).
const testTo = args.testTo ?? cfg.testTo;
if (testTo) {
  say('\n5. Test message');
  let to = null;
  try { to = normalizeRecipient(testTo); } catch (e) { fail(e.message); failed = true; }
  if (to && chosen) {
    if (args.dryRun) say(`  would send the hello_world template to …${to.slice(-4)}`);
    else {
      const r = await graph(`${chosen.phone_number_id}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } } });
      if (r.ok) {
        ok(`hello_world sent to …${to.slice(-4)}. Reply to it from your phone: Avery should answer within a few seconds.`);
      } else { fail(`send failed: ${explainGraphError(r.status, r.json)}`); failed = true; }
    }
  }
} else next.push('Send yourself a test: run again with --test-to <your WhatsApp number>, then reply to it.');

say(`\n${failed ? 'Some steps need attention (see ✗ above).' : args.dryRun ? 'Dry run finished: nothing was changed.' : 'Done.'}`);
if (next.length) { say('Next:'); next.forEach((s, i) => say(`  ${i + 1}. ${s}`)); }
process.exit(failed ? 1 : 0);
