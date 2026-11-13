import { describe, expect, it } from 'vitest';
import { nextAction, parseSecretList, render, scrub } from '../scripts/preflight-lib.mjs';

const view = (id: string, status: string, extra: any = {}) => ({
  id, name: id.toUpperCase(), requirement: 'required', status, getFrom: 'https://example.com', missing: [], lastCheck: null,
  settings: [{ name: `${id.toUpperCase()}_KEY`, required: true, set: status !== 'not_configured' }, { name: 'EMAIL_FROM', plain: true, required: true, set: false }], ...extra,
});

describe('preflight', () => {
  it('reads secret names from wrangler secret list', () => {
    expect(parseSecretList('[{"name":"A_KEY","type":"secret_text"},{"name":"B","type":"secret_text"}]')).toEqual(['A_KEY', 'B']);
    expect(parseSecretList('noise\n[{"name":"X"}]\n')).toEqual(['X']);
    expect(parseSecretList('')).toEqual([]);
  });

  it('says what to do next for each state', () => {
    expect(nextAction(view('resend', 'not_configured', { missing: ['RESEND_KEY', 'EMAIL_FROM'] }), [])).toBe('wrangler secret put RESEND_KEY; set var EMAIL_FROM in wrangler.toml (from https://example.com)');
    expect(nextAction(view('a', 'fail', { lastCheck: { ok: false, error: 'HTTP 401' } }), [])).toMatch(/HTTP 401/);
    expect(nextAction(view('a', 'ok'), ['A_KEY'])).toBe('');
    expect(nextAction(view('a', 'ok'), [])).toBe('move A_KEY to wrangler secret (now a plain var)');
  });

  it('renders a checklist with blockers', () => {
    const out = render({ integrations: [view('a', 'ok'), view('b', 'not_configured', { missing: ['B_KEY'] })],
      readiness: { score: 50, ready: false, blockers: [{ id: 'b', name: 'B', status: 'not_configured', reason: 'Not set up' }] } }, null);
    expect(out).toContain('✓ A (required) — Working');
    expect(out).toContain('✗ B (required) — Not set up');
    expect(out).toContain('    - B: Not set up');
  });

  it('scrubs the admin key', () => {
    expect(scrub('refused key adm-123456', 'adm-123456')).toBe('refused key [redacted]');
  });
});
