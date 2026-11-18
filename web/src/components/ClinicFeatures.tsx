import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Card, Status } from './ui';

// Settings → WhatsApp → Clinic follow-ups: four switches, all off until turned on.
// Messages use the approved WhatsApp templates (SMS fallback) and respect STOP.

interface Features {
  durationBooking: boolean; recalls: boolean; recallMonths: number; recallCategory: string | null;
  noShowRecovery: boolean; reviewRequests: boolean; reviewUrl: string | null;
}

export default function ClinicFeatures({ base, auth, sector }: { base: string; auth: Record<string, string>; sector: string }) {
  const [f, setF] = useState<Features | null>(null);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/clinic/${encodeURIComponent(sector)}`;
  useEffect(() => { api<Features>(base, path, auth).then(d => { setF(d); setUrl(d.reviewUrl ?? ''); }).catch(e => setMsg({ text: e.message, ok: false })); }, [base, path, auth]);

  const save = async (patch: Partial<Features>) => {
    setBusy(true); setMsg(null);
    try { setF(await api<Features>(base, path, auth, { method: 'PUT', body: patch })); setMsg({ text: 'Saved.', ok: true }); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };
  if (!f) return <Status msg={msg} />;
  const toggle = (k: keyof Features, label: string, hint: string) => (
    <label className="row" style={{ alignItems: 'flex-start' }}>
      <input type="checkbox" checked={!!f[k]} disabled={busy} onChange={e => save({ [k]: e.target.checked })} />
      <span><b>{label}</b><br /><span className="muted small">{hint}</span></span>
    </label>
  );
  return (
    <Card title="Clinic follow-ups" description="Each one is off until you turn it on. Messages go on WhatsApp (or SMS), and patients who replied STOP get nothing.">
      <Status msg={msg} />
      <div className="stack-sm">
        {toggle('durationBooking', 'Book by procedure length', 'Each service books its full duration; no more patients overlap than you have chairs (Settings → Business → capacity). Doctors already book this way.')}
        {toggle('noShowRecovery', 'No-show recovery', 'When you mark a visit "No-show", the patient gets a message to book a new time, and a "call back to rebook" task appears in Messages.')}
        {toggle('recalls', 'Recalls', `About ${f.recallMonths} months after a completed visit${f.recallCategory ? ` (${f.recallCategory})` : ''}, the patient is invited to book again, unless they already have a later booking.`)}
        {f.recalls && (
          <div className="row">
            <label className="small">Months <input type="number" min={1} max={36} value={f.recallMonths} onChange={e => save({ recallMonths: Number(e.target.value) })} style={{ width: 70 }} /></label>
            <label className="small">Only for service category <input defaultValue={f.recallCategory ?? ''} placeholder="any" onBlur={e => save({ recallCategory: e.target.value || null })} /></label>
          </div>
        )}
        <label className="small">Google review link <input value={url} onChange={e => setUrl(e.target.value)} onBlur={() => url !== (f.reviewUrl ?? '') && save({ reviewUrl: url || null })} placeholder="https://g.page/r/…/review" /></label>
        {toggle('reviewRequests', 'Review requests', 'Two hours after you mark a visit "Came", the patient gets your Google review link. Every patient gets the same message: Google does not allow asking only happy patients.')}
      </div>
    </Card>
  );
}
