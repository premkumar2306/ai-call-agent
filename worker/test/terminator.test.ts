import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallTerminator } from '../src/telephony/terminator';

function harness(over: Record<string, string> = {}) {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: any = {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
    setAlarm: async (t: number) => { alarm = t; },
    deleteAlarm: async () => { alarm = null; },
  };
  const kv = new Map<string, string>();
  const sql: { q: string; args: unknown[] }[] = [];
  const env: any = {
    CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
    DB: { prepare: (q: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { sql.push({ q, args }); } }) }) },
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token', PLIVO_AUTH_ID: 'MAtest', PLIVO_AUTH_TOKEN: 'plivo-secret',
    ...over,
  };
  const t = new CallTerminator(storage, env);
  return { t, env, kv, sql, store, alarm: () => alarm };
}

let calls: { method: string; url: string }[];
let responses: ((url: string, method: string) => Response)[];
beforeEach(() => {
  calls = []; responses = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) });
    return (responses.shift() ?? (() => new Response('{}', { status: 500 })))(String(url), init?.method ?? 'GET');
  });
});

const json = (o: unknown, status = 200) => () => new Response(JSON.stringify(o), { status });
const future = (ms = 6000) => Date.now() + ms;

describe('CallTerminator', () => {
  it('only the first request acts (idempotent under concurrent triggers)', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 10);
    const r = await Promise.all([h.t.request('silence'), h.t.request('caller_hangup'), h.t.request('max_duration')]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it('multiplexes one alarm: backstop until a hang-up is requested, then the verify time', async () => {
    const h = harness();
    const backstop = future(60_000);
    await h.t.start('CA1', 'twilio', backstop, 10);
    expect(h.alarm()).toBe(backstop);
    await h.t.request('silence');
    expect(h.alarm()).toBeLessThan(backstop);
  });

  it('reports the backstop when due and nothing was requested', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', Date.now() - 1, 10);
    expect(await h.t.onAlarm()).toBe('backstop');
  });

  it('twilio: carrier still in progress → status read, REST hangup, then confirmed', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('silence');
    responses = [json({ status: 'in-progress' }), json({ status: 'completed' }), json({ status: 'completed', duration: '42', end_time: 'Tue, 24 Nov 2026 10:00:00 +0000' })];
    await new Promise(r => setTimeout(r, 5));
    await h.t.onAlarm();   // verify
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1].url).toContain('/Accounts/ACtest/Calls/CA1.json');
    await new Promise(r => setTimeout(r, 5));
    await h.t.onAlarm(Date.now() + 5000);   // recheck
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(h.sql.some(s => /hangup_method/.test(s.q) && s.args[0] === 'rest')).toBe(true);
    expect(h.sql.some(s => /carrier_duration_seconds/.test(s.q) && s.args[1] === 42)).toBe(true);
  });

  it('does not hang up when the callback already confirmed the end', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('agent_hangup');
    h.kv.set('ended:CA1', JSON.stringify({ durationSec: 30, source: 'callback' }));
    await h.t.onAlarm(Date.now() + 10);
    expect(calls).toHaveLength(0);
    expect(h.sql.some(s => /hangup_method/.test(s.q) && s.args[0] === 'callback')).toBe(true);
  });

  it('does not hang up when the status read says the call ended', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('agent_hangup');
    responses = [json({ status: 'completed', duration: '9' })];
    await h.t.onAlarm(Date.now() + 10);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('never hangs up a transfer by REST', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('transfer');
    responses = [json({ status: 'in-progress' })];
    await h.t.onAlarm(Date.now() + 10);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('plivo: live → DELETE; 404 on the live read = ended', async () => {
    const h = harness();
    await h.t.start('uuid-1', 'plivo', future(60_000), 1);
    await h.t.request('max_duration');
    responses = [json({ call_status: 'in-progress' }), () => new Response(null, { status: 204 }), json({}, 404)];
    await h.t.onAlarm(Date.now() + 10);
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[1].url).toContain('/Account/MAtest/Call/uuid-1/');
    await h.t.onAlarm(Date.now() + 5000);
    expect(h.sql.some(s => /hangup_method/.test(s.q) && s.args[0] === 'rest')).toBe(true);
  });

  it('exotel: still live → alert only (no hangup API), never throws', async () => {
    const h = harness({ EXOTEL_ACCOUNT_SID: 'ex', EXOTEL_API_KEY: 'k', EXOTEL_API_TOKEN: 't' });
    await h.t.start('ex-1', 'exotel', future(60_000), 1);
    await h.t.request('silence');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    responses = [json({ Call: { Status: 'in-progress' } })];
    await h.t.onAlarm(Date.now() + 10);
    expect(calls.map(c => c.method)).toEqual(['GET']);
    expect(err.mock.calls.some(c => String(c[0]).includes('call.hangup_unconfirmed'))).toBe(true);
    err.mockRestore();
  });

  it('no credentials: logs and does nothing else', async () => {
    const h = harness({ TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '' });
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('silence');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await h.t.onAlarm(Date.now() + 10);
    expect(calls).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a REST error never throws and never leaks the credentials into logs', async () => {
    const h = harness();
    await h.t.start('CA1', 'twilio', future(60_000), 1);
    await h.t.request('silence');
    const out: string[] = [];
    const sp = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map(s => s.mockImplementation((x: any) => { out.push(String(x)); }));
    responses = [json({ status: 'in-progress' }), json({ message: 'boom' }, 401), json({ status: 'in-progress' })];
    await h.t.onAlarm(Date.now() + 10);
    await h.t.onAlarm(Date.now() + 5000);
    sp.forEach(s => s.mockRestore());
    expect(out.join('\n')).not.toContain('secret-token');
    expect(out.join('\n')).toContain('call.hangup_unconfirmed');
  });
});
