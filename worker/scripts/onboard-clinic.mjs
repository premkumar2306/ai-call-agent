#!/usr/bin/env node
// Onboard a campaign lead as a draft Avery business with the India dental preset.
//
//   npm run onboard:clinic -- --lead <slug>                  # dry run (default): prints what would be created
//   npm run onboard:clinic -- --lead <slug> --apply          # creates it
//   --front-desk-phone "+91…"   also switches front-desk confirmation on (the API needs that number)
//   --md                        dry run as a markdown section
//
// Needs WORKER_URL and ADMIN_KEY in the environment (the key is never printed).
// Uses only existing admin APIs. It maps no phone number, creates no owner
// account and sends nothing to anyone. Re-running is safe: a finished business
// is left untouched; an interrupted run resumes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDIA_DENTAL as P, businessKey, serviceId, pilotWindow } from '../src/services/presets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAMPAIGN = join(ROOT, 'campaigns', 'india-dental-leads');

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const leadId = opt('lead');
const APPLY = flag('apply');
const frontDesk = opt('front-desk-phone');

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
if (!leadId) fail('usage: npm run onboard:clinic -- --lead <id> [--apply] [--front-desk-phone +91…] [--md]');

// ── The lead: public business data only ─────────────────────────────────────
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const approved = readJson(join(CAMPAIGN, 'approved-organizations.json'));
const row = approved.organizations.find(o => o.slug === leadId);
if (!row) fail(`"${leadId}" is not in approved-organizations.json`);
const city = row.city.toLowerCase();
const org = readJson(join(CAMPAIGN, 'data', 'cities', city, 'organization-targets.json')).organizations.find(o => o.slug === leadId);
if (!org) fail(`no public record for "${leadId}" in data/cities/${city}/organization-targets.json`);
const loc = org.primaryLocation ?? {};
const lead = {
  name: String(org.clinicName ?? org.organizationName).trim().slice(0, 80),
  address: [loc.address, [loc.locality, loc.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ').slice(0, 300) || undefined,
  locality: loc.locality ?? org.city, city: org.city,
  website: (loc.publicWebsites ?? org.publicWebsites ?? [])[0],
  publicPhones: loc.publicPhones ?? org.publicPhones ?? [],   // shown for reference; never stored or dialled
};

// ── The plan: every call, in order ──────────────────────────────────────────
const key = businessKey(leadId);
const vendorId = `${key}-v`;
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
const steps = [
  { id: 'sector', label: 'Create the business', method: 'POST', path: '/admin/sectors', createOnly: true, body: {
    key, name: lead.name, model: 'service', categories: ['SERVICES', 'CONSULTATION'], hours: P.hours,
    timezone: P.timezone, currency: P.currency, locale: P.locale, country_code: P.countryCode,
    ...(lead.address ? { address: lead.address } : {}), ...(lead.website ? { website: lead.website } : {}),
    vertical: 'clinic', ...P.voice } },
  { id: 'kind', label: 'Dental wording (kind = dental)', method: 'PUT', path: `/admin/sectors/${key}`, body: { kind: P.kind } },
  { id: 'vendor', label: 'Vendor row', method: 'POST', path: '/admin/vendors', body: { id: vendorId, name: lead.name, business_type: key } },
  { id: 'services', label: `Starter services (${P.services.length})`, method: 'POST', path: '/admin/products',
    body: P.services.map(s => ({ id: serviceId(key, s.name), business_type: key, vendor_id: vendorId, vendor_name: lead.name, name: s.name,
      category: s.category, type: 'SERVICE_APPOINTMENT', fulfillment_type: 'SERVICE_BOOKING', description: '', price_cents: 0, duration_minutes: s.durationMinutes })) },
  { id: 'dtmf', label: 'DTMF digit input', method: 'PUT', path: `/admin/sectors/${key}/voice`, body: { dtmf_input: P.dtmfInput } },
  { id: 'fillers', label: 'Natural fillers (no dead air)', method: 'PUT', path: `/admin/sectors/${key}/voice`, body: { natural_fillers: P.naturalFillers } },
  { id: 'guardrails', label: 'Guardrails', method: 'PUT', path: `/admin/guardrails/${key}`, body: { enabled: P.guardrails } },
  { id: 'dpdp', label: 'DPDP disclosure', method: 'PUT', path: `/admin/privacy/${key}/settings`, body: { ...P.dpdp } },
  { id: 'clinic', label: 'Duration booking ON; recalls, no-show, review requests OFF', method: 'PUT', path: `/clinic/${key}`, body: {
    durationBooking: P.durationBooking, recalls: P.whatsapp.recalls, noShowRecovery: P.whatsapp.noShowRecovery, reviewRequests: P.whatsapp.reviewRequests } },
  { id: 'whatsapp', label: 'WhatsApp reminders and missed-call follow-up OFF', method: 'PUT', path: `/admin/whatsapp/business/${key}`, body: {
    reminders: P.whatsapp.reminders, missedCallFollowup: P.whatsapp.missedCallFollowup } },
  { id: 'pilot', label: `Overflow pilot (draft; ${P.pilot.days} days start at activation)`, method: 'PUT', path: `/pilot/${key}`, body: { enabled: false, startsOn: null, endsOn: null } },
  frontDesk
    ? { id: 'confirm', label: 'Front-desk confirmation ON', method: 'PUT', path: `/practice/${key}`, body: { confirmationMode: P.confirmationMode, frontDeskPhone: frontDesk } }
    : { id: 'confirm', label: 'Front-desk confirmation ON', skip: 'needs the front desk phone from the owner (rerun with --front-desk-phone, or set it in Settings → Practice software)' },
  { id: 'plan', label: `Billing plan ${P.plan} (not charged until the owner subscribes)`, method: 'PUT', path: `/admin/billing/accounts/${key}`, body: { planId: P.plan } },
  { id: 'offer', label: `Offer ${P.offer} attached`, method: 'POST', path: `/admin/billing/accounts/${key}/offer`, body: { code: P.offer } },
];

// ── Output ──────────────────────────────────────────────────────────────────
const BASE = (process.env.WORKER_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.ADMIN_KEY ?? '';
const show = v => JSON.stringify(v);
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'X-Admin-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

if (!BASE || !KEY) {
  if (APPLY) fail('--apply needs WORKER_URL and ADMIN_KEY in the environment');
  console.error('! WORKER_URL / ADMIN_KEY not set: dry run without checking what already exists');
}

// What exists already (read-only).
let state = 'not checked';
if (BASE && KEY) {
  const s = await call('GET', `/admin/sectors/${key}`);
  if (s.status === 404) state = 'new';
  else if (!s.ok) fail(`could not check ${key}: HTTP ${s.status}`);
  else {
    const b = await call('GET', `/admin/billing/accounts/${key}`);
    state = b.ok && b.json?.data?.planId ? 'done' : 'partial';
  }
}

const bodyText = st => (st.skip ? `SKIPPED: ${st.skip}` : `${st.method} ${st.path} ${show(st.body)}`);

if (flag('md') && !APPLY) {
  const rows = [
    ['Country / currency / timezone / locale', `${P.countryCode} / ${P.currency} / ${P.timezone} / ${P.locale}`],
    ['Voice language', 'English + Hindi/Hinglish (`hi-en`, Sarvam speech and voice)'],
    ['Vertical', 'clinic, kind `dental` (dentist wording)'],
    ['Starter services', P.services.map(s => `${s.name} (${s.durationMinutes} min)`).join(', ')],
    ['Duration booking', 'ON'], ['Guardrails', 'ON'], ['DTMF digit input', 'ON'],
    ['Billing plan', `\`${P.plan}\` with offer \`${P.offer}\` attached; nothing charged until the owner subscribes`],
    ['Pilot', `overflow mode, ${P.pilot.days} days from activation (draft, dates set at activation)`],
    ['Front-desk confirmation', frontDesk ? 'ON' : 'ON once the owner gives the front desk phone (the API requires it)'],
    ['WhatsApp reminders / recalls / review requests / no-show recovery / missed-call follow-up', 'all OFF until the owner\'s templates are approved'],
    ['DPDP disclosure', 'ON, built-in wording in the line\'s language (English + Hindi)'],
    ['Opening hours', 'placeholder Mon–Fri 9am–6pm, Sat 10am–2pm; owner to confirm'],
    ['Avery phone number', 'none mapped'],
  ];
  console.log(`## ${lead.name}\n\n- Area: ${lead.locality === lead.city ? lead.city : `${lead.locality}, ${lead.city}`}\n- Website: ${lead.website ?? 'none listed'}\n- Business key: \`${key}\`\n- Public address: ${lead.address ?? 'none listed'}\n\n`);
  console.log('| Setting | Value |\n|---|---|');
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  console.log(`\nOwner runs: \`WORKER_URL=… ADMIN_KEY=… npm run onboard:clinic -- --lead ${leadId} --apply\`\n`);
  process.exit(0);
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${lead.name} (${lead.locality === lead.city ? lead.city : `${lead.locality}, ${lead.city}`}) → business key ${key}`);
console.log(`  website: ${lead.website ?? 'none listed'}   public phone (reference only, not stored): ${lead.publicPhones[0] ?? 'none'}`);
console.log(`  state: ${state === 'done' ? 'already onboarded (nothing will change)' : state}`);
console.log(`  pilot at activation: PUT /pilot/${key} ${show({ enabled: true, ...pilotWindow(today, P.pilot.days) })} (dates shown for today)`);
for (const st of steps) {
  if (state === 'done' || (state === 'partial' && st.createOnly)) continue;
  console.log(`  - ${st.label}\n      ${bodyText(st)}`);
}
if (!APPLY) { console.log('\nNothing was changed. Add --apply to create it (draft: no phone number mapped, nothing sent).'); process.exit(0); }
if (state === 'done') { console.log('\n✓ Already onboarded; nothing changed.'); process.exit(0); }

for (const st of steps) {
  if (st.skip || (state === 'partial' && st.createOnly)) continue;
  const r = await call(st.method, st.path, st.body);
  if (!r.ok) fail(`${st.label}: HTTP ${r.status} ${String(r.json?.error ?? r.text).slice(0, 200)}`);
  console.log(`  ✓ ${st.label}`);
}
console.log(`\n✓ ${lead.name} is a draft business (${key}). Next for the owner: add the owner email, hours, doctors, map an Avery number, then activate.`);
