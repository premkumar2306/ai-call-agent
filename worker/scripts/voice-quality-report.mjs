#!/usr/bin/env node
// Voice quality report for one business, from the operator API. Read-only; prints numbers and
// short trigger words, never a transcript, a name or a phone number.
//
//   WORKER_URL=https://<worker> ADMIN_KEY=… npm run voice:report -- --business <key> --days 7
//
// <key> is the business key: Admin site → the business → Business tab (or Settings → URL), e.g. jd_dental.

import { renderReport, summariseCall } from './voice-quality-report-lib.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const business = arg('business');
const days = Math.min(90, Math.max(1, Number(arg('days')) || 7));
const workerUrl = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '';
if (!business || !/^https?:\/\//.test(workerUrl) || !adminKey) {
  console.error('Usage: WORKER_URL=https://<worker> ADMIN_KEY=… npm run voice:report -- --business <key> [--days 7]');
  process.exit(2);
}

const get = async path => {
  const res = await fetch(`${workerUrl}${path}`, { headers: { 'X-Admin-Key': adminKey }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()).data ?? null;
};

const list = await get(`/admin/calls?business=${encodeURIComponent(business)}&days=${days}`);
const settings = await get(`/admin/sectors/${encodeURIComponent(business)}/voice`).catch(() => null);
const calls = [];
for (const o of (list?.calls ?? []).filter(c => !c.is_test)) {
  const data = await get(`/admin/calls/${encodeURIComponent(o.call_sid)}/turns`).catch(() => null);
  calls.push(summariseCall(o, data, settings?.language ?? null));   // calls with no turn metrics still show duration and end reason
}
if (!calls.length) console.log(`No calls for "${business}" in the last ${days} day(s). Check the business key.`);
else console.log(renderReport({ business, days, settings, calls }));
