import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, Status } from '../components/ui';

// Settings → Phone → Overflow pilot: keep the clinic's own number, staff
// answer first, and the carrier forwards busy / no-answer / unreachable calls
// to Avery. Off until the owner sets dates and turns it on. The forwarding
// codes for each carrier are in docs/overflow-pilot.md (shown below in short).

interface Data {
  config: null | { enabled: boolean; startsOn: string | null; endsOn: string | null; clinicNumber: string | null; clinicLine: string | null };
  active: boolean;
  averyNumbers: { number: string; provider: string }[];
  clinicLines: string[];
  recent: { at: number; carrier: string; isOverflow: boolean; reason: string; forwardedFrom: string | null }[];
  forwardingTest: { status: 'not_started' | 'waiting' | 'received' | 'expired'; startedAt: number | null; expiresAt?: number;
    call: null | { at: number; forwardedFrom: string | null; forwardedFromMatches: boolean | null; reason: string } };
}

const LINE_LABEL: Record<string, string> = { jio: 'Jio mobile', airtel: 'Airtel mobile', vi: 'Vi mobile', bsnl: 'BSNL mobile', landline: 'Landline', ivr: 'IVR / cloud PBX', other: 'Other' };

// Short versions of the guide. "verify" = not confirmed from the carrier's own documentation.
function codesFor(line: string | null, avery: string): string[] {
  const n10 = avery.replace(/^\+91/, '');
  switch (line) {
    case 'jio': return [`Busy: *405*${n10}  (cancel *406)`, `No answer: *403*${n10}  (cancel *404)`, 'Unreachable: code varies — use MyJio → Call Forwarding (verify with Jio)'];
    case 'airtel': case 'vi': case 'bsnl': return [`Busy: **67*${avery}#`, `No answer: **61*${avery}#`, `Unreachable: **62*${avery}#`, 'Cancel: ##67#, ##61#, ##62# (verify with your carrier)'];
    case 'landline': return ['Ask your landline provider to set "call forward on busy / no reply" to the Avery number (codes differ by exchange).'];
    case 'ivr': return ['In your IVR / cloud PBX, set the "no answer" or "busy" fallback of the staff step to the Avery number.'];
    default: return ['See the forwarding guide for your carrier.'];
  }
}

const fmt = (t: number) => new Date(t * 1000).toLocaleString();

export default function PilotSettings({ base, auth, sector }: { base: string; auth: Record<string, string>; sector: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState({ enabled: false, startsOn: '', endsOn: '', clinicNumber: '', clinicLine: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/pilot/${encodeURIComponent(sector)}`;

  const load = () => api<Data>(base, path, auth).then(d => {
    setData(d);
    if (d.config) setForm({ enabled: d.config.enabled, startsOn: d.config.startsOn ?? '', endsOn: d.config.endsOn ?? '', clinicNumber: d.config.clinicNumber ?? '', clinicLine: d.config.clinicLine ?? '' });
  }).catch(e => setMsg({ text: e.message, ok: false }));
  useEffect(() => { load(); }, [base, path, auth]);

  // Poll while a forwarding test is waiting.
  useEffect(() => {
    if (data?.forwardingTest.status !== 'waiting') return;
    const t = setInterval(() => api<Data['forwardingTest']>(base, `${path}/forwarding-test`, auth)
      .then(ft => setData(d => d && { ...d, forwardingTest: ft })).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [data?.forwardingTest.status]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ text: ok, ok: true }); await load(); } catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  if (!data) return <Status msg={msg} />;
  const avery = data.averyNumbers[0]?.number ?? '';
  const ft = data.forwardingTest;

  return (
    <Card title={<>Overflow pilot on your own number {data.active ? <Badge tone="success">Running</Badge> : <Badge>Off</Badge>}</>}
      description="Keep your clinic's number. Your staff answer first; when the line is busy, nobody answers or the phone is unreachable, your carrier forwards the call to your assistant. Calls that arrive this way are marked as overflow.">
      <Status msg={msg} />
      {!avery
        ? <p className="muted">Your assistant needs its own number first (Settings → Phone). Forwarding goes to that number.</p>
        : <p>Forward to: <strong>{avery}</strong></p>}
      <form className="stack-sm" onSubmit={e => { e.preventDefault(); run(() => api(base, path, auth, { method: 'PUT', body: form }), 'Saved.'); }}>
        <label>Your clinic's number <input value={form.clinicNumber} onChange={e => setForm({ ...form, clinicNumber: e.target.value })} placeholder="+91 80 4123 4567" /></label>
        <label>Line type <select value={form.clinicLine} onChange={e => setForm({ ...form, clinicLine: e.target.value })}>
          <option value="">Choose…</option>
          {data.clinicLines.map(l => <option key={l} value={l}>{LINE_LABEL[l] ?? l}</option>)}
        </select></label>
        <div className="row">
          <label>Pilot starts <input type="date" value={form.startsOn} onChange={e => setForm({ ...form, startsOn: e.target.value })} /></label>
          <label>Pilot ends <input type="date" value={form.endsOn} onChange={e => setForm({ ...form, endsOn: e.target.value })} /></label>
        </div>
        <label className="row"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Pilot on between these dates</label>
        <Button type="submit" disabled={busy}>Save</Button>
      </form>

      {avery && (
        <div className="stack-sm">
          <h4>Set up forwarding on your clinic's line</h4>
          <ul className="small">{codesFor(form.clinicLine || null, avery).map(c => <li key={c}><code>{c}</code></li>)}</ul>
          <p className="muted small">Dial these from the clinic's phone. Full guide, with sources: docs/overflow-pilot.md.</p>
        </div>
      )}

      <div className="stack-sm">
        <h4>Test your forwarding</h4>
        <p className="muted small">Start the test, then call your clinic's number from another phone and don't pick up (or reject the call). Within a minute it should reach your assistant.</p>
        <Button variant="secondary" disabled={busy || !avery} onClick={() => run(() => api(base, `${path}/forwarding-test`, auth, { method: 'POST' }), 'Test started: call your clinic number now.')}>Start test</Button>
        {ft.status === 'waiting' && <p><Badge tone="warning">Waiting</Badge> for a forwarded call until {ft.expiresAt ? fmt(ft.expiresAt) : '—'}…</p>}
        {ft.status === 'expired' && <p><Badge tone="danger">No call arrived</Badge> Check the forwarding code and that it was dialled from the clinic's line, then try again.</p>}
        {ft.status === 'received' && ft.call && <p><Badge tone="success">Forwarding works</Badge> A call reached your assistant at {fmt(ft.call.at)}.
          {ft.call.forwardedFrom
            ? ft.call.forwardedFromMatches === false ? ` The carrier said it was forwarded from ${ft.call.forwardedFrom}, not the clinic number you entered.` : ` Forwarded from ${ft.call.forwardedFrom}.`
            : ' (Your carrier did not send the forwarding number; that is normal on some networks.)'}</p>}
      </div>

      {data.recent.length > 0 && (
        <div className="stack-sm">
          <h4>Recent calls</h4>
          <ul className="small">{data.recent.slice(0, 10).map(r => <li key={`${r.carrier}${r.at}${r.reason}${r.forwardedFrom}`}>{fmt(r.at)} — {r.isOverflow ? 'overflow' : 'direct'}{r.forwardedFrom ? ` from ${r.forwardedFrom}` : ''}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}
