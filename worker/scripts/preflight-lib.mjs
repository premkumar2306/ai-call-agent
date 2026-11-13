// Pure helpers for scripts/preflight.mjs (tested in test/preflight.test.ts).
// Works from setting NAMES and booleans only; never sees a secret value.

const MARK = { ok: '✓', fail: '✗', not_configured: '✗', unchecked: '!' };
const LABEL = { ok: 'Working', fail: 'Failing', not_configured: 'Not set up', unchecked: 'Set up, not checked' };
const REQ = { required: 'required', carrier: 'phone carrier', optional: 'optional' };

/** `wrangler secret list` output (JSON array, or the pretty table) → names. */
export function parseSecretList(stdout) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('[');
  if (start >= 0) {
    try { return JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)).map(s => s.name).filter(Boolean); } catch { /* fall through */ }
  }
  return [...text.matchAll(/"name"\s*:\s*"([A-Z0-9_]+)"/g)].map(m => m[1]);
}

/** The next action for one integration, as plain text. */
export function nextAction(i, secretNames) {
  if (i.status === 'not_configured') {
    return i.missing.map(m => {
      const s = i.settings.find(x => x.name === m);
      return s?.plain ? `set var ${m} in wrangler.toml` : `wrangler secret put ${m}`;
    }).join('; ') + ` (from ${i.getFrom})`;
  }
  if (i.status === 'fail') return `fix the key (${i.lastCheck?.error ?? 'check failed'}); see ${i.getFrom}`;
  if (i.status === 'unchecked') return i.lastCheck?.note ?? 'run the check again';
  // Secrets the Worker sees but `wrangler secret list` doesn't: set as plain
  // vars by mistake, so they sit in wrangler.toml / the dashboard in clear.
  const exposed = secretNames ? i.settings.filter(s => s.set && !s.plain && !secretNames.includes(s.name) && !['DB', 'CACHE'].includes(s.name)) : [];
  return exposed.length ? `move ${exposed.map(s => s.name).join(', ')} to wrangler secret (now a plain var)` : '';
}

export function render(data, secretNames) {
  const order = { required: 0, carrier: 1, optional: 2 };
  const rows = [...data.integrations].sort((a, b) => order[a.requirement] - order[b.requirement]);
  const lines = ['', `Avery go-live checklist — readiness ${data.readiness.score}%`, ''];
  for (const i of rows) {
    const action = nextAction(i, secretNames);
    lines.push(`${MARK[i.status]} ${i.name} (${REQ[i.requirement]}) — ${LABEL[i.status]}${i.lastCheck?.ok != null ? `, ${i.lastCheck.latencyMs} ms` : ''}`);
    if (action) lines.push(`    → ${action}`);
  }
  lines.push('');
  if (data.readiness.ready) lines.push('✓ Ready for go-live: every required service is working.');
  else {
    lines.push(`✗ Not ready. Blockers:`);
    for (const b of data.readiness.blockers) lines.push(`    - ${b.name}: ${b.reason}`);
  }
  lines.push('', 'Then follow docs/live-test-checklist.md for the live call, WhatsApp and billing tests.');
  return lines.join('\n');
}

/** Scrub anything that looks like the admin key from text we print. */
export function scrub(text, adminKey) {
  let t = String(text);
  if (adminKey && adminKey.length >= 4) t = t.split(adminKey).join('[redacted]');
  return t;
}
