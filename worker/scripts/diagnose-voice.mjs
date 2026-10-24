#!/usr/bin/env node
/**
 * Triage the inbound-call path without a phone.
 *
 * Reproduces exactly what Twilio does on an incoming call: POSTs the same
 * form fields to /twilio/inbound with a real `X-Twilio-Signature`, computed
 * the same way (base64 HMAC-SHA1 over the full URL plus the alphabetically
 * sorted, concatenated parameters). If this gets TwiML back, a real call
 * will too; if it doesn't, the failure here is the failure on the phone.
 *
 * Usage:
 *   TWILIO_AUTH_TOKEN=... node scripts/diagnose-voice.mjs
 *   TWILIO_AUTH_TOKEN=... node scripts/diagnose-voice.mjs https://my-worker.example.workers.dev
 *
 * The auth token is the one from the Twilio console — the same value the
 * Worker has as its TWILIO_AUTH_TOKEN secret. It is used locally to sign the
 * probe and is never printed.
 *
 * Without a token the script still runs the health check, which on its own
 * names any missing production config.
 */

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://mogi-platform.premkumar-2ba.workers.dev';

/**
 * Twilio's request-signature scheme.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken, url, params) {
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

const ok   = (s) => `\x1b[32m${s}\x1b[0m`;
const bad  = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  const base = (process.argv[2] ?? DEFAULT_URL).replace(/\/$/, '');
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  console.log(`\nTarget: ${base}\n`);

  // ── 1. Health + config readiness ────────────────────────────────────────
  console.log('1. GET /health?deep=1');
  let health;
  try {
    const res = await fetch(`${base}/health?deep=1`, { signal: AbortSignal.timeout(15_000) });
    health = await res.json().catch(() => null);
    console.log(`   HTTP ${res.status}  ${JSON.stringify(health)}`);
    const missing = health?.config?.missing;
    if (Array.isArray(missing) && missing.length) {
      console.log(bad(`   ✘ unset in production: ${missing.join(', ')}`));
      console.log('     Set each with:  wrangler secret put <NAME>');
      process.exitCode = 1;
    } else if (!res.ok) {
      process.exitCode = 1;
    } else {
      console.log(ok('   ✔ bindings healthy, required config present'));
    }
    if (missing === undefined) {
      console.log(warn('   ! no config block — the Worker predates the readiness check (PR #25)'));
    }
  } catch (e) {
    console.log(bad(`   ✘ unreachable: ${e.message}`));
    console.log('     Nothing below will work until the Worker responds.');
    process.exit(1);
  }

  // ── 2. Signed /twilio/inbound, exactly as Twilio sends it ───────────────
  console.log('\n2. POST /twilio/inbound  (signed like a real inbound call)');
  if (!authToken) {
    console.log(warn('   skipped — set TWILIO_AUTH_TOKEN to run this check'));
    console.log('   This is the step that distinguishes a signature/URL mismatch');
    console.log('   from missing config, so it is worth running.');
    return;
  }

  const path = '/twilio/inbound';
  const url = `${base}${path}`;
  const params = {
    CallSid: 'CA00000000000000000000000000000000',
    AccountSid: 'AC00000000000000000000000000000000',
    From: '+13125550123',
    To: '+13126854305',
    CallStatus: 'ringing',
    Direction: 'inbound',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilioSignature(authToken, url, params),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  console.log(`   HTTP ${res.status}`);
  console.log(`   ${text.trim().slice(0, 500)}`);

  if (res.status === 403) {
    console.log(bad('\n   ✘ Signature rejected.'));
    console.log('     The Worker signs with TWILIO_WEBHOOK_URL + path. It must equal the URL');
    console.log(`     actually requested — here, ${url}`);
    console.log('     Check:  wrangler secret put TWILIO_WEBHOOK_URL   (base URL, no trailing slash)');
    console.log('     and that the Twilio console Voice webhook points at this same host.');
    console.log('     `npx wrangler tail` now logs signedUrl vs requestUrl on each mismatch.');
    process.exitCode = 1;
  } else if (!res.ok) {
    console.log(bad(`\n   ✘ ${res.status} — the caller hears Twilio's generic application error.`));
    console.log('     Run `npx wrangler tail` and repeat this command to see the thrown error.');
    process.exitCode = 1;
  } else if (!text.includes('<Stream')) {
    console.log(warn('\n   ! 200, but no <Stream> in the TwiML.'));
    console.log('     The call would connect and then do nothing. Body is above.');
    process.exitCode = 1;
  } else {
    console.log(ok('\n   ✔ Signature accepted and <Connect><Stream> returned.'));
    console.log('     The inbound webhook is healthy — a real call gets this far.');
    const token = /name="streamToken" value="([^"]+)"/.exec(text);
    console.log(token
      ? ok('     ✔ stream token minted (TOKEN_SECRET is usable)')
      : warn('     ! no streamToken parameter — the media stream will be rejected'));
  }
}

// Only run when invoked directly — the signing function is imported by
// test/diagnose-voice.test.ts, which must not trigger a live probe.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(bad(`\nunexpected: ${e.stack || e.message}`)); process.exit(1); });
}
