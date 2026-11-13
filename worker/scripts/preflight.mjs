#!/usr/bin/env node
// Production preflight: is every outside service set up and working?
//
//   WORKER_URL=https://api.example.in ADMIN_KEY=… npm run preflight
//   npm run preflight -- --no-check     # don't run live checks, just report
//   npm run preflight -- --no-wrangler  # skip `wrangler secret list` (CI, e2e)
//
// 1. `wrangler secret list` — which secrets exist on the deployed Worker (names only).
// 2. GET /admin/integrations on the deployed Worker (booleans per setting name).
// 3. POST /admin/integrations/:id/check for every set-up service (read-only checks).
// 4. Prints a ✓ / ✗ checklist with the next action. Exit code 1 until ready.
// Never prints a secret value: it never receives one.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSecretList, render, scrub } from './preflight-lib.mjs';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.WORKER_URL || '').replace(/\/$/, '');
const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '';
const runChecks = !process.argv.includes('--no-check');

if (!url || !adminKey) {
  console.error('Set WORKER_URL (the deployed Worker, https://…) and ADMIN_KEY (the operator admin key) in the environment.');
  process.exit(2);
}

let secretNames = null;
const list = process.argv.includes('--no-wrangler') ? { status: -1 } : spawnSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { cwd: WORKER_DIR, encoding: 'utf8' });
if (list.status === 0) {
  secretNames = parseSecretList(list.stdout);
  console.log(`wrangler secret list: ${secretNames.length} secret(s) on the deployed Worker.`);
} else if (list.status !== -1) {
  console.log('! Could not run `wrangler secret list` (run `npx wrangler login` first). Continuing with the Worker\'s own report.');
}

async function call(method, path) {
  const res = await fetch(`${url}${path}`, { method, headers: { 'X-Admin-Key': adminKey } });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

try {
  let r = await call('GET', '/admin/integrations');
  if (r.status === 401) throw new Error('The admin key was refused (401). Check ADMIN_KEY.');
  if (r.status !== 200 || !r.json?.data) throw new Error(`GET /admin/integrations → ${r.status}. Is this Worker deployed with this branch?`);
  if (runChecks) {
    for (const i of r.json.data.integrations) {
      if (i.status === 'not_configured') continue;
      const c = await call('POST', `/admin/integrations/${i.id}/check`);
      if (c.status === 429) process.stdout.write(`(${i.id}: checked moments ago, using that result) `);
    }
    r = await call('GET', '/admin/integrations');
  }
  console.log(render(r.json.data, secretNames));
  process.exit(r.json.data.readiness.ready ? 0 : 1);
} catch (e) {
  console.error(`✗ ${scrub(e.message || e, adminKey)}`);
  process.exit(2);
}
