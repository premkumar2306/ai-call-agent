import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, EmptyState, Status, Table } from './ui';

// Operator: each WhatsApp number's health from Meta (quality rating,
// messaging-limit tier, display-name status, verified name), when the webhook
// last delivered a message, and whether each event's template is approved.
// Shown on Operator → WhatsApp and Operator → Integrations.

export interface NumberHealth {
  phoneNumberId: string; businessType: string | null; label: string | null;
  displayPhoneNumber: string | null; verifiedName: string | null; nameStatus: string | null;
  qualityRating: string | null; messagingLimitTier: string | null; status: string | null;
  error: string | null; checkedAt: number | null; lastMessageAt: number | null;
}
export interface TemplateSummary { event: string; family: string | null; ready: boolean; variants: { variant: string; name: string; language: string; status: string | null }[] }
interface Health { numbers: NumberHealth[]; templates: TemplateSummary[]; webhookFields: string[] }

export const EVENT_LABEL: Record<string, string> = {
  confirmation: 'Booking confirmation', reminder: 'Reminder (24 h before)', cancellation: 'Cancellation', missed_call: 'Missed call',
};
const QUALITY: Record<string, ['success' | 'warning' | 'danger' | undefined, string]> = {
  GREEN: ['success', 'High'], YELLOW: ['warning', 'Medium'], RED: ['danger', 'Low'], UNKNOWN: [undefined, 'Unknown'],
};
const TIER: Record<string, string> = {
  TIER_50: '50 / day', TIER_250: '250 / day', TIER_1K: '1,000 / day', TIER_10K: '10,000 / day', TIER_100K: '100,000 / day', TIER_UNLIMITED: 'Unlimited',
};

export function templateTone(status: string | null): 'success' | 'warning' | 'danger' | undefined {
  if (status === 'APPROVED') return 'success';
  if (status === 'PENDING' || status === 'IN_APPEAL') return 'warning';
  if (status && ['REJECTED', 'PAUSED', 'DISABLED'].includes(status)) return 'danger';
  return undefined;
}

function ago(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export default function WhatsAppHealth({ base, adminKey, sectors, compact }: { base: string; adminKey: string; sectors?: { key: string; name: string }[]; compact?: boolean }) {
  const auth = { 'X-Admin-Key': adminKey };
  const [data, setData] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const nameOf = (key: string | null) => (key ? sectors?.find(s => s.key === key)?.name ?? key : 'Default business');

  useEffect(() => {
    api<Health>(base, '/admin/whatsapp/health', auth).then(setData).catch(e => setMsg({ text: e.message, ok: false }));
  }, [base, adminKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setBusy(true); setMsg(null);
    try { setData(await api<Health>(base, '/admin/whatsapp/health/refresh', auth, { method: 'POST' })); setMsg({ text: 'Refreshed from Meta.', ok: true }); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  const bad = data?.numbers.filter(n => n.qualityRating === 'YELLOW' || n.qualityRating === 'RED') ?? [];
  return (
    <Card
      title={<>WhatsApp number health {bad.length > 0 && <Badge tone="danger">{bad.length} need attention</Badge>}</>}
      description="From Meta, refreshed every hour. A drop to medium or low quality emails the operator (ADMIN_NOTIFY_EMAIL)."
      actions={<Button variant="secondary" size="sm" busy={busy} onClick={refresh}>Refresh</Button>}
    >
      {!data && !msg && <p className="muted" role="status">Loading…</p>}
      {data && data.numbers.length === 0 && <EmptyState title="No WhatsApp numbers yet">Map a number on Operator → WhatsApp.</EmptyState>}
      {data && data.numbers.length > 0 && (
        <Table head={['Number', 'Business', 'Quality', 'Daily limit', 'Display name', 'Last message']}>
          {data.numbers.map(n => {
            const [tone, q] = QUALITY[n.qualityRating ?? ''] ?? [undefined, n.checkedAt ? (n.qualityRating ?? 'Unknown') : 'Not checked'];
            return (
              <tr key={n.phoneNumberId}>
                <td data-label="Number">
                  <span className="strong">{n.displayPhoneNumber ?? n.label ?? 'Not checked yet'}</span>
                  <span className="muted small mono block">{n.phoneNumberId}</span>
                  {n.error && <span className="bad small block">{n.error}</span>}
                </td>
                <td data-label="Business">{nameOf(n.businessType)}</td>
                <td data-label="Quality"><Badge tone={tone}>{q}</Badge></td>
                <td data-label="Daily limit">{n.messagingLimitTier ? TIER[n.messagingLimitTier] ?? n.messagingLimitTier : '—'}</td>
                <td data-label="Display name">
                  {n.verifiedName ?? '—'}{' '}
                  {n.nameStatus && <Badge tone={n.nameStatus === 'APPROVED' ? 'success' : n.nameStatus === 'DECLINED' ? 'danger' : 'warning'}>{n.nameStatus.replace(/_/g, ' ').toLowerCase()}</Badge>}
                </td>
                <td data-label="Last message" className={n.lastMessageAt && Date.now() - n.lastMessageAt < 7 * 86400e3 ? '' : 'dim'}>{ago(n.lastMessageAt)}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {data && !compact && (
        <>
          <h3 className="subhead">Templates in use</h3>
          <ul className="plain-list small">
            {data.templates.map(t => (
              <li key={t.event}>
                <span className="strong">{EVENT_LABEL[t.event] ?? t.event}:</span>{' '}
                {!t.family ? <span className="muted">none chosen (SMS or nothing)</span> : t.variants.map(v => (
                  <span key={v.variant} className="nowrap"><Badge tone={templateTone(v.status)}>{v.variant} {v.status ? v.status.toLowerCase() : 'not on Meta'}</Badge> </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="muted small">"Last message" is when the webhook last delivered a customer message to that number. In Meta, subscribe the webhook to: {data.webhookFields.map((f, i) => <span key={f}>{i ? ', ' : ''}<code>{f}</code></span>)}.</p>
        </>
      )}
      <Status msg={msg} />
    </Card>
  );
}
