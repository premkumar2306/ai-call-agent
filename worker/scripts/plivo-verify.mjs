#!/usr/bin/env node
// Live Plivo check for the owner:
//
//   WORKER_URL=https://<worker> ADMIN_KEY=… npm run plivo:verify
//
// 1. GET /health on the deployed Worker.
// 2. POST /plivo/answer with no signature: must be rejected (403).
// 3. GET /admin/plivo/verify (operator key): the Plivo account check with the
//    real keys, the account's numbers, each number's Application answer and
//    hangup URLs, and which Avery business each number reaches.
// 4. Prints a ✓ / ✗ checklist with the exact fix for each ✗. Exit 1 until ready.
//
// Read-only: never prints a secret value (it never receives one), never
// places a call, never spends money.

import { renderPlivoVerify, scrubAll } from './plivo-verify-lib.mjs';

const workerUrl = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '';
if (!/^https?:\/\//.test(workerUrl) || !adminKey) {
  console.error('Set WORKER_URL (the deployed Worker, https://…) and ADMIN_KEY (the operator admin key) in the environment.');
  process.exit(2);
}

const timeout = () => AbortSignal.timeout(20_000);
const health = await fetch(`${workerUrl}/health?deep=1`, { signal: timeout() })
  .then(r => ({ ok: r.ok, status: r.status }), e => ({ ok: false, status: e.message }));
const unsigned = await fetch(`${workerUrl}/plivo/answer`, {
  method: 'POST', signal: timeout(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ CallUUID: 'plivo-verify-unsigned', From: '910000000000', To: '910000000001', Direction: 'inbound' }).toString(),
}).then(r => ({ status: r.status }), e => ({ status: e.message }));

let report = null, reportError;
try {
  const res = await fetch(`${workerUrl}/admin/plivo/verify`, { headers: { 'X-Admin-Key': adminKey }, signal: timeout() });
  const json = await res.json().catch(() => null);
  if (res.ok && json?.data) report = json.data;
  else reportError = `HTTP ${res.status}${json?.error ? `: ${json.error}` : ''}`;
} catch (e) {
  reportError = e.message;
}

const { lines, ok, next } = renderPlivoVerify({ workerUrl, health, unsigned, report, reportError });
const out = [`Plivo live check — ${workerUrl}`, '', ...lines, '', ok ? 'All Plivo checks pass.' : 'Next actions:', ...next.map(n => `  → ${n}`)].join('\n');
console.log(scrubAll(out, [adminKey]));
process.exit(ok ? 0 : 1);
