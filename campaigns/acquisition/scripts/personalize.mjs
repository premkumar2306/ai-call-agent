#!/usr/bin/env node
// Fills demo_slug, demo_url, first_line (and whatsapp, when the clinic's own site publishes a
// wa.me / api.whatsapp.com link) in campaigns/acquisition/leads.csv. Sends nothing.
//
//   node campaigns/acquisition/scripts/personalize.mjs            # slugs + first lines, fetch websites
//   node campaigns/acquisition/scripts/personalize.mjs --offline  # slugs + fallback first lines only
//   node campaigns/acquisition/scripts/personalize.mjs --limit 50 # fetch at most 50 sites
//
// Politeness: one request at a time, 2 s apart, 10 s timeout, honest User-Agent, robots.txt
// checked before fetching the home page; skips sites that disallow "/". Only the home page is read.
// rating, review_count and missed_call_signal are filled by hand from the clinic's public
// Google/Practo listing (Google Maps terms do not allow scraping) — see README.md.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = join(here, '..', 'leads.csv');
const DEMO_BASE = process.env.DEMO_BASE ?? 'https://demo.deskzen.in/?demo=';
const UA = 'DeskZenLeadResearch/1.0 (+https://deskzen.in; one-page business research)';
const args = process.argv.slice(2);
const offline = args.includes('--offline');
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const force = args.includes('--force');

export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return { header, records: body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

export function toCsv(header, records) {
  const esc = (v) => (/[",\n]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ''));
  return [header.join(','), ...records.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

export function slugify(...parts) {
  return parts.filter(Boolean).join(' ').toLowerCase()
    .replace(/^dr\.?\s+/, 'dr ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
}

const SPECIALTIES = [
  [/implant/i, 'implants'], [/aligner|invisalign|orthodont|braces/i, 'aligners and braces'],
  [/root canal|endodont/i, 'root canal treatment'], [/smile design|cosmetic|veneer/i, 'smile design'],
  [/kids|child|pediatric|paediatric|pedo/i, "children's dentistry"], [/laser/i, 'laser dentistry'],
];

export function firstLine(lead, page = '') {
  const area = lead.area && !lead.area.startsWith('PIN') ? ` in ${lead.area}` : '';
  const spec = SPECIALTIES.find(([re]) => re.test(page) || re.test(lead.name));
  const hours = /sunday|24\s*x\s*7|24\/7|till\s+(9|10)\s*pm/i.exec(page);
  if (spec && hours) return `Saw that ${lead.name}${area} does ${spec[1]} and keeps long hours — those late calls are exactly the ones that slip through.`;
  if (spec) return `Saw that ${lead.name}${area} offers ${spec[1]} — patients asking about that usually call 2–3 clinics and book with whoever answers first.`;
  if (/call (us )?(to|for) (book|appointment)|call now/i.test(page)) return `Noticed your site asks patients to call to book — so every unanswered call is a lost appointment.`;
  return `Came across ${lead.name}${area} while looking at clinics in ${lead.city}.`;
}

function extractWhatsapp(html) {
  const m = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{10,13})/i.exec(html);
  if (!m) return '';
  const digits = m[1].replace(/\D/g, '');
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
}

async function get(url) {
  const ctrl = AbortSignal.timeout(10000);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, redirect: 'follow', signal: ctrl });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, 400000);
}

export function robotsAllows(robots, path = '/') {
  let applies = false; const rules = [];
  for (const raw of robots.split('\n')) {
    const line = raw.split('#')[0].trim(); const [k, ...v] = line.split(':'); const val = v.join(':').trim();
    if (/^user-agent$/i.test(k)) applies = val === '*' || /deskzen/i.test(val);
    else if (applies && /^disallow$/i.test(k) && val) rules.push(val);
  }
  return !rules.some((r) => path.startsWith(r));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCKED_HOSTS = /facebook\.|instagram\.|google\.|practo\.|justdial\.|lybrate\./i;

async function main() {
  const { header, records } = parseCsv(await readFile(csvPath, 'utf8'));
  const slugs = new Set();
  let fetched = 0;
  for (const lead of records) {
    if (!lead.demo_slug || force) {
      let slug = slugify(lead.name, lead.area?.startsWith('PIN') ? lead.city : lead.area.split('/')[0]);
      for (let n = 2; slugs.has(slug); n++) slug = `${slugify(lead.name, lead.area, lead.city)}-${n}`;
      lead.demo_slug = slug;
    }
    slugs.add(lead.demo_slug);
    lead.demo_url = `${DEMO_BASE}${encodeURIComponent(lead.demo_slug)}`;
    let page = '';
    const site = lead.website && !BLOCKED_HOSTS.test(lead.website) ? lead.website : '';
    if (!offline && site && fetched < limit && (!lead.first_line || force)) {
      fetched++;
      try {
        const origin = new URL(site).origin;
        const robots = await get(`${origin}/robots.txt`).catch(() => '');
        await sleep(2000);
        if (robotsAllows(robots, new URL(site).pathname || '/')) {
          const html = await get(site);
          page = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          if (!lead.whatsapp) lead.whatsapp = extractWhatsapp(html);
        } else lead.notes = [lead.notes, 'robots.txt disallows; not fetched'].filter(Boolean).join('; ');
      } catch (error) {
        lead.notes = [lead.notes, `site unreachable (${error.message.slice(0, 40)})`].filter(Boolean).join('; ');
      }
      await sleep(2000);
      process.stderr.write(`\r${fetched} sites`);
    }
    if (!lead.first_line || force || page) lead.first_line = firstLine(lead, page);
  }
  await writeFile(csvPath, toCsv(header, records));
  console.error(`\nupdated ${records.length} leads (${fetched} websites fetched)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
