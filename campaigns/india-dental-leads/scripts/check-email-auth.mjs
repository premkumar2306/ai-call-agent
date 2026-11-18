// Checks the DNS records that decide whether mail from a Microsoft 365 domain is authenticated.
// Usage: node check-email-auth.mjs --domain deskzen.in
import dns from 'node:dns/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const notFound = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

async function lookup(fn) {
  try {
    return await fn();
  } catch (error) {
    if (notFound.has(error.code)) return [];
    throw error;
  }
}

// Returns { checks: [{ name, ok, blocker, detail, fix }], blocked }.
// A "blocker" failure stops campaign sends; the others are warnings.
export async function checkEmailAuth(domain, resolver = dns) {
  const checks = [];
  const add = (name, ok, blocker, detail, fix) => checks.push({ name, ok, blocker, detail, fix: ok ? null : fix });

  const spf = (await lookup(() => resolver.resolveTxt(domain)))
    .map((parts) => parts.join(''))
    .filter((record) => /^v=spf1(\s|$)/i.test(record));
  add('SPF', spf.length === 1 && /include:spf\.protection\.outlook\.com/i.test(spf[0]), false,
    spf.length ? `${spf.length} SPF record(s)` : 'no SPF record',
    `Publish exactly one TXT record on ${domain}, e.g. "v=spf1 include:spf.protection.outlook.com -all". Merge, never add a second SPF record.`);

  const dmarc = (await lookup(() => resolver.resolveTxt(`_dmarc.${domain}`)))
    .map((parts) => parts.join(''))
    .filter((record) => /^v=DMARC1/i.test(record));
  const policy = dmarc[0]?.match(/(?:^|;)\s*p=(\w+)/i)?.[1]?.toLowerCase();
  add('DMARC', Boolean(policy), false, policy ? `policy p=${policy}` : 'no DMARC record',
    `Add TXT _dmarc.${domain}: "v=DMARC1; p=quarantine".`);

  for (const selector of ['selector1', 'selector2']) {
    const name = `${selector}._domainkey.${domain}`;
    const targets = await lookup(() => resolver.resolveCname(name));
    add(`DKIM ${selector}`, targets.length > 0, true, targets.length ? `CNAME -> ${targets[0]}` : `${name} returns nothing`,
      `Add CNAME ${name} (DNS only, no proxy) with the value shown in Defender > Email authentication settings > DKIM. See docs/email-deliverability.md.`);
  }

  const mx = await lookup(() => resolver.resolveMx(domain));
  const hosts = mx.map((record) => `${record.exchange.replace(/\.$/, '').toLowerCase()} (${record.priority})`);
  add('MX', mx.length === 1 && /\.mail\.protection\.outlook\.com$/i.test(mx[0].exchange.replace(/\.$/, '')), true,
    hosts.length ? hosts.join(', ') : 'no MX record',
    `Keep only one MX: ${domain.replace(/\./g, '-')}.mail.protection.outlook.com, priority 0. Remove leftover MX records after confirming they are unused.`);

  return { checks, blocked: checks.some((check) => check.blocker && !check.ok) };
}

export function formatChecks(domain, { checks, blocked }) {
  const lines = [`Email authentication for ${domain}`];
  for (const check of checks) {
    lines.push(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    if (check.fix) lines.push(`    Fix: ${check.fix}`);
  }
  lines.push(blocked ? 'RESULT: blocked (DKIM or MX failing)' : 'RESULT: ok');
  return lines.join('\n');
}

async function cli() {
  const index = process.argv.indexOf('--domain');
  const domain = index > 0 ? process.argv[index + 1] : undefined;
  if (!domain) {
    console.error('Usage: node check-email-auth.mjs --domain <domain>');
    process.exit(2);
  }
  const result = await checkEmailAuth(domain);
  console.log(formatChecks(domain, result));
  process.exit(result.blocked ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await cli();
}
