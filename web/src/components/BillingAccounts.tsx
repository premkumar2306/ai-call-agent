import { useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, Table } from './ui';

// Operator: every business's billing status this month (GET /admin/billing/accounts).

interface Row {
  businessType: string; name: string; countryCode: string; state: string; overageAllowed: boolean;
  plan: { id: string; name: string; includedMinutes: number } | null; trialEndsAt: number | null;
  subscriptionStatus: string | null; cancelAtPeriodEnd: boolean; lastPaymentStatus: string | null;
  minutes: number; costPaise: number;
}

const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const LABEL: Record<string, [string, 'success' | 'warning' | 'danger' | 'info' | undefined]> = {
  off: ['Billing off', undefined], trialing: ['Trial', 'info'], active: ['Subscribed', 'success'], past_due: ['Payment failed', 'danger'],
  paused: ['Paused', 'warning'], cancelled: ['Cancelled', 'warning'], unpaid: ['Trial ended', 'warning'],
};

export default function BillingAccounts({ base, auth, current, onSelect }: { base: string; auth: Record<string, string>; current: string; onSelect: (key: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch(`${base}/admin/billing/accounts`, { headers: auth }).then(r => r.json())
      .then(j => { if (live) (j.success ? setRows(j.data) : setError(j.error ?? 'Could not load')); })
      .catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [base, auth, current]);

  return (
    <Card title="All businesses" description="Billing status and minutes this month. Choose one to manage its plan and see its costs below.">
      {error ? <Notice tone="error">{error}</Notice> : !rows ? <p className="muted" role="status">Loading…</p> : (
        <Table head={['Business', 'Plan', 'Status', 'Minutes', 'Cost', '']}>
          {rows.map(r => {
            const [label, tone] = LABEL[r.state] ?? [r.state, undefined];
            return (
              <tr key={r.businessType} aria-current={r.businessType === current ? 'true' : undefined}>
                <td data-label="Business">{r.name} <span className="muted small">{r.countryCode}</span></td>
                <td data-label="Plan">{r.plan?.name ?? '—'}</td>
                <td data-label="Status">
                  <Badge tone={tone}>{r.cancelAtPeriodEnd && r.state === 'active' ? 'Cancels at period end' : label}</Badge>
                  {!r.overageAllowed && r.plan && <span className="muted small"> overage paused</span>}
                </td>
                <td data-label="Minutes">{r.minutes}{r.plan ? ` / ${r.plan.includedMinutes}` : ''}</td>
                <td data-label="Cost">{inr(r.costPaise)}</td>
                <td data-label="">{r.businessType !== current && <Button variant="secondary" size="sm" onClick={() => onSelect(r.businessType)}>Manage</Button>}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}
