import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Card, EmptyState, Notice, Table } from './ui';

// Operator only: estimated provider cost of every call and WhatsApp
// conversation this month, the revenue it brought in, and the margin
// (GET /admin/billing/calls/:key).

interface Row {
  id: string; sourceId: string; channel: string; provider: string | null; billable: boolean;
  startedAt: number; durationSeconds: number; billableMinutes: number; llmModel: string | null;
  costPaise: number; phonePaise: number; speechPaise: number; aiPaise: number; revenuePaise: number; marginPaise: number;
}
interface Data { period: string; rows: Row[]; unallocatedFeePaise: number }

const inr = (paise: number) => `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const months = (n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
});
const kind = (r: Row) => (r.provider === 'web' ? 'Test call' : r.channel === 'whatsapp' ? 'WhatsApp' : r.billable ? 'Call' : 'Synthetic test');
const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export default function CallCosts({ base, auth, sector }: { base: string; auth: Record<string, string>; sector: string }) {
  const [period, setPeriod] = useState(months(1)[0]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null); setError('');
    api<Data>(base, `/admin/billing/calls/${encodeURIComponent(sector)}?period=${period}`, auth)
      .then(d => live && setData(d)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [base, auth, sector, period]);

  const sum = (k: keyof Row) => (data?.rows ?? []).reduce((a, r) => a + (r[k] as number), 0);
  const totalRevenue = sum('revenuePaise') + (data?.unallocatedFeePaise ?? 0);

  return (
    <Card
      className="card-accent"
      title={<>Cost per call <Badge tone="accent">Operator only</Badge></>}
      description="Estimated provider cost of each call and WhatsApp conversation (from list prices; tune them with BILLING_COST_RATES), the plan revenue it earned, and the margin. Amounts exclude GST."
      actions={
        <select className="input input-sm input-auto" aria-label="Month" value={period} onChange={e => setPeriod(e.target.value)}>
          {months(6).map(m => <option key={m} value={m}>{new Date(`${m}-15`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</option>)}
        </select>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {data && data.rows.length === 0 && (
        <EmptyState title="No calls recorded this month">
          Phone calls, WhatsApp conversations and in-app test calls appear here once they end.
        </EmptyState>
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="figures">
            <div><span className="figure">{inr(sum('costPaise'))}</span><p className="muted small">total cost</p></div>
            <div><span className="figure">{inr(totalRevenue)}</span><p className="muted small">revenue{data.unallocatedFeePaise ? ' (incl. unused plan minutes)' : ''}</p></div>
            <div><span className={`figure ${totalRevenue - sum('costPaise') < 0 ? 'bad' : 'ok'}`}>{inr(totalRevenue - sum('costPaise'))}</span><p className="muted small">margin</p></div>
          </div>
          <Table head={['When', 'Type', 'Length', 'Phone line', 'Speech', 'AI', 'Cost', 'Revenue', 'Margin']}>
            {data.rows.map(r => (
              <tr key={r.id}>
                <td data-label="When">{new Date(r.startedAt * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
                <td data-label="Type">{r.billable ? kind(r) : <Badge>{kind(r)}</Badge>}</td>
                <td data-label="Length">{r.channel === 'voice' && r.provider !== 'web' ? `${dur(r.durationSeconds)} (${r.billableMinutes} min)` : '—'}</td>
                <td className="num" data-label="Phone line">{inr(r.phonePaise)}</td>
                <td className="num" data-label="Speech">{inr(r.speechPaise)}</td>
                <td className="num" data-label="AI">{inr(r.aiPaise)}</td>
                <td className="num strong" data-label="Cost">{inr(r.costPaise)}</td>
                <td className="num" data-label="Revenue">{inr(r.revenuePaise)}</td>
                <td className={`num ${r.marginPaise < 0 ? 'bad' : 'ok'}`} data-label="Margin">{inr(r.marginPaise)}</td>
              </tr>
            ))}
            <tr className="total-row">
              <td data-label="Total" colSpan={3}>Total ({data.rows.length})</td>
              <td className="num" data-label="Phone line">{inr(sum('phonePaise'))}</td>
              <td className="num" data-label="Speech">{inr(sum('speechPaise'))}</td>
              <td className="num" data-label="AI">{inr(sum('aiPaise'))}</td>
              <td className="num strong" data-label="Cost">{inr(sum('costPaise'))}</td>
              <td className="num" data-label="Revenue">{inr(sum('revenuePaise'))}</td>
              <td className={`num ${sum('marginPaise') < 0 ? 'bad' : 'ok'}`} data-label="Margin">{inr(sum('marginPaise'))}</td>
            </tr>
          </Table>
          <p className="muted small">
            Revenue per call: the plan fee spread over its included minutes, then the overage rate, in call order.
            {data.unallocatedFeePaise > 0 && ` ${inr(data.unallocatedFeePaise)} of this month's fee covers minutes not used yet, so it isn't tied to a call.`}
            {' '}Test calls and WhatsApp conversations cost money but aren't billed.
          </p>
        </>
      )}
    </Card>
  );
}
