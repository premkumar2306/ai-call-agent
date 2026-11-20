import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Button, Card } from './ui';

// Home → "Assistant results": answer rate, recovered bookings, transfer rate
// (and no-show rate once tracked), computed by the Worker from real calls and
// bookings only. No data → "No calls yet", never sample figures.
// Formulas: docs/pilot-metrics.md.

interface Metrics {
  calls: number; answered: number; answerRate: number | null; overflowCalls: number; afterHoursCalls: number;
  transfers: number; transferRate: number | null; bookingsFromCalls: number; recoveredBookings: number;
  noShow: { status: 'not_tracked' } | { status: 'ok'; before: number | null; after: number | null };
}
interface Data { window: { label: string }; metrics: Metrics; settings: { weeklySummary: boolean; shareEnabled: boolean; shareToken: string | null }; hasPilot: boolean }

const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export default function PilotResults({ base, auth, sector, isOwner }: { base: string; auth: Record<string, string>; sector: string; isOwner: boolean }) {
  const [range, setRange] = useState<'pilot' | '7' | '30' | '90'>('30');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const q = range === 'pilot' ? '?pilot=1' : `?days=${range}`;
  useEffect(() => { api<Data>(base, `/metrics/${encodeURIComponent(sector)}${q}`, auth).then(setData).catch(e => setError(e.message)); }, [base, sector, q, auth]);

  const save = async (patch: Partial<Data['settings']>) => {
    setBusy(true);
    try {
      const settings = await api<Data['settings']>(base, `/metrics/${encodeURIComponent(sector)}/settings`, auth, { method: 'PUT', body: patch });
      setData(d => d && { ...d, settings });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (error) return <Card title="Assistant results"><p className="muted">{error}</p></Card>;
  if (!data) return null;
  const m = data.metrics;
  const shareUrl = data.settings.shareToken ? `${base}/report/${data.settings.shareToken}` : null;

  return (
    <Card title="Assistant results" description={`${data.window.label}. From your real calls and bookings.`}
      actions={<select aria-label="Period" value={range} onChange={e => setRange(e.target.value as typeof range)}>
        {data.hasPilot && <option value="pilot">Pilot dates</option>}
        <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
      </select>}>
      {m.calls === 0 ? <p className="muted">No calls have reached your assistant in this period yet.</p> : (
        <div className="figures">
          <div><span className="figure">{pct(m.answerRate)}</span><p className="muted small">answer rate ({m.answered} of {m.calls} calls)</p></div>
          <div><span className="figure">{m.recoveredBookings}</span><p className="muted small">recovered bookings (overflow {m.overflowCalls} / after-hours {m.afterHoursCalls} calls)</p></div>
          <div><span className="figure">{pct(m.transferRate)}</span><p className="muted small">transferred to staff ({m.transfers})</p></div>
          <div><span className="figure">{m.noShow.status === 'ok' ? `${pct(m.noShow.before)} → ${pct(m.noShow.after)}` : '—'}</span><p className="muted small">no-show rate {m.noShow.status === 'ok' ? 'before → after' : '(not tracked yet)'}</p></div>
        </div>
      )}
      {isOwner && (
        <div className="stack-sm">
          <label className="row small"><input type="checkbox" checked={data.settings.weeklySummary} disabled={busy} onChange={e => save({ weeklySummary: e.target.checked })} /> Email me a weekly summary (Mondays)</label>
          <label className="row small"><input type="checkbox" checked={data.settings.shareEnabled} disabled={busy} onChange={e => save({ shareEnabled: e.target.checked })} /> Share a read-only report link</label>
          {shareUrl && <div className="stack-sm">
            <p className="small muted">Anyone with this link can see these figures (no patient details):</p>
            <div className="share-link">
              <a href={shareUrl} target="_blank" rel="noreferrer" title={shareUrl}>{shareUrl}</a>
              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true), () => {})}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>}
        </div>
      )}
    </Card>
  );
}
