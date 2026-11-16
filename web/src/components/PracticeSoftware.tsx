import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Button, Card, Status } from './ui';

// Settings → Business → Practice software: front-desk confirmation mode and
// read-only calendar (ICS) import. Both off until turned on.
// What each vendor supports: docs/practice-software.md.

interface Data {
  software: string | null; confirmationMode: boolean; frontDeskPhone: string | null;
  icsImport: boolean; icsUrlSet: boolean; icsUrlHost: string | null; icsLastSync: number | null; icsLastError: string | null; icsBusyCount: number | null;
}
const SOFTWARE: Record<string, string> = { practo: 'Practo (Ray)', clinicia: 'Clinicia', eka: 'Eka Care', other: 'Other software', none: 'Paper diary / none' };

export default function PracticeSoftware({ base, auth, sector }: { base: string; auth: Record<string, string>; sector: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [phone, setPhone] = useState('');
  const [ics, setIcs] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/practice/${encodeURIComponent(sector)}`;
  useEffect(() => { api<Data>(base, path, auth).then(x => { setD(x); setPhone(x.frontDeskPhone ?? ''); }).catch(e => setMsg({ text: e.message, ok: false })); }, [base, path, auth]);
  const save = async (patch: Record<string, unknown>, ok = 'Saved.') => {
    setBusy(true); setMsg(null);
    try { setD(await api<Data>(base, path, auth, { method: 'PUT', body: patch })); setMsg({ text: ok, ok: true }); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); } finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api<{ busy: number }>(base, `${path}/ics/sync`, auth, { method: 'POST' }); setMsg({ text: `Imported ${r.busy} busy time${r.busy === 1 ? '' : 's'}.`, ok: true }); setD(await api<Data>(base, path, auth)); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); } finally { setBusy(false); }
  };
  if (!d) return <Status msg={msg} />;
  return (
    <Card title="Practice software" description="Keep your diary in Practo, Clinicia, Eka or on paper. Your assistant never writes into it.">
      <Status msg={msg} />
      <div className="stack-sm">
        <label>Your software <select value={d.software ?? ''} disabled={busy} onChange={e => save({ software: e.target.value || null })}>
          <option value="">Choose…</option>{Object.entries(SOFTWARE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>Front desk mobile <input value={phone} onChange={e => setPhone(e.target.value)} onBlur={() => phone !== (d.frontDeskPhone ?? '') && save({ frontDeskPhone: phone || null })} placeholder="+91 98450 12345" /></label>
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={d.confirmationMode} disabled={busy} onChange={e => save({ confirmationMode: e.target.checked })} />
          <span><b>Front desk confirms each booking</b><br /><span className="muted small">The patient is told the booking is pending. Your front desk gets a text with a link: one tap to Confirm, or suggest another time. The patient is messaged either way.</span></span>
        </label>
        <hr />
        <label>Calendar (ICS) link from your software <input value={ics} onChange={e => setIcs(e.target.value)} placeholder={d.icsUrlSet ? `Saved (${d.icsUrlHost}) — paste to replace` : 'https://… or webcal://…'} /></label>
        <div className="row">
          <Button size="sm" variant="secondary" disabled={busy || !ics.trim()} onClick={() => save({ icsUrl: ics.trim() }).then(() => setIcs(''))}>Save link</Button>
          <Button size="sm" variant="secondary" disabled={busy || !d.icsImport} onClick={sync}>Import now</Button>
        </div>
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={d.icsImport} disabled={busy || !d.icsUrlSet} onChange={e => save({ icsImport: e.target.checked })} />
          <span><b>Use its busy times</b><br /><span className="muted small">Read-only, refreshed every hour: times booked in your software are not offered to callers.{d.icsLastSync ? ` Last import: ${new Date(d.icsLastSync * 1000).toLocaleString()}${d.icsLastError ? ` — failed: ${d.icsLastError}` : `, ${d.icsBusyCount ?? 0} busy times.`}` : ''}</span></span>
        </label>
      </div>
    </Card>
  );
}
