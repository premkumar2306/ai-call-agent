import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, EmptyState, Notice, Status, Table } from '../components/ui';

// Operator → WhatsApp: what WhatsApp routing is, whether this deployment is
// set up for it (GET /admin/whatsapp-status, booleans only), and which
// business answers each number (/admin/whatsapp-numbers).

interface Props { base: string; adminKey: string; sectors: { key: string; name: string }[] }
interface WaStatus { appSecret: boolean; verifyToken: boolean; accessToken: boolean; phoneNumberMap: boolean; webhookPath: string }
interface WaRow { phoneNumberId: string; businessType: string; label: string | null }

const README = 'https://github.com/premkumar2306/ai-call-agent#whatsapp-setup';

export default function WhatsAppSetup({ base, adminKey, sectors }: Props) {
  const auth = { 'X-Admin-Key': adminKey };
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [rows, setRows] = useState<WaRow[] | null>(null);
  const [id, setId] = useState('');
  const [business, setBusiness] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;

  const load = () => api<WaRow[]>(base, '/admin/whatsapp-numbers', auth).then(setRows).catch(e => setMsg({ text: e.message, ok: false }));
  useEffect(() => {
    api<WaStatus>(base, '/admin/whatsapp-status', auth).then(setStatus).catch(e => setMsg({ text: e.message, ok: false }));
    load();
  }, [base, adminKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ text: ok, ok: true }); await load(); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  const webhook = `${base}${status?.webhookPath ?? '/whatsapp/webhook'}`;
  const steps = status && [
    { done: status.verifyToken, title: 'Verify token', detail: <>Worker setting <code>WA_VERIFY_TOKEN</code>: the same token you type into Meta's webhook settings.</> },
    { done: status.appSecret, title: 'App secret', detail: <>Worker setting <code>WA_APP_SECRET</code>: checks that each message really comes from Meta.</> },
    { done: status.accessToken, title: 'Access token', detail: <>Worker setting <code>WA_ACCESS_TOKEN</code>: a permanent system-user token, used to send replies.</> },
    { done: status.verifyToken && status.appSecret, title: 'Webhook URL in Meta', detail: <>Set the callback URL to <code>{webhook}</code> and subscribe to <code>messages</code>. We can't check this from here.</>, unknown: true },
    { done: !!rows?.length || status.phoneNumberMap, title: 'Map a number to a business', detail: 'Below: which business answers messages sent to each number.' },
  ];
  const nothingSet = status && !status.verifyToken && !status.appSecret && !status.accessToken;

  return (
    <>
      <Card title="How WhatsApp works">
        <p>
          Each WhatsApp Business number in Meta's WhatsApp Manager has a <span className="strong">phone number ID</span> (a long number, not the phone number itself).
          When a customer messages that number, Meta sends it to this service, and the mapping below decides which business's assistant answers.
          Numbers that aren't mapped are answered by the default phone line's business.
        </p>
        <p className="muted small">Conversations appear in each business's Calls &amp; messages page.</p>
      </Card>

      <Card title="Setup on this deployment" description="Checked live. Values are never shown, only whether they are set.">
        {nothingSet && <Notice tone="warning">WhatsApp isn't set up on this deployment yet. Follow the steps below, or the <a href={README} target="_blank" rel="noreferrer">WhatsApp setup guide</a> in the README.</Notice>}
        {!steps ? <p className="muted" role="status">Checking…</p> : (
          <ul className="checklist">
            {steps.map(s => (
              <li key={s.title}>
                <span className={`check${s.done ? ' done' : ''}`} aria-hidden="true">✓</span>
                <div className="what">{s.title}<span>{s.detail}</span></div>
                {s.unknown ? <Badge>Check in Meta</Badge> : s.done ? <Badge tone="success">Done</Badge> : <Badge tone="warning">Missing</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Numbers and businesses" description="Which business answers each WhatsApp number. Changes apply to the next message; no redeploy needed.">
        {rows && rows.length === 0 && (
          <EmptyState title="No WhatsApp numbers mapped yet">
            Find the phone number ID in Meta's WhatsApp Manager (API Setup), then add it below with the business that should answer.
          </EmptyState>
        )}
        {rows && rows.length > 0 && (
          <Table head={['Phone number ID', 'Business', 'Label', <span className="sr-only">Actions</span>]}>
            {rows.map(r => (
              <tr key={r.phoneNumberId}>
                <td className="mono" data-label="Number ID">{r.phoneNumberId}</td>
                <td data-label="Business">{nameOf(r.businessType)}</td>
                <td className="dim" data-label="Label">{r.label ?? ''}</td>
                <td className="num">
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => confirm(`Stop routing ${r.phoneNumberId}?`) &&
                    run(() => api(base, `/admin/whatsapp-numbers/${r.phoneNumberId}`, auth, { method: 'DELETE' }), `${r.phoneNumberId} removed.`)}>Remove</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <form className="form-row" onSubmit={e => {
          e.preventDefault();
          run(() => api(base, '/admin/whatsapp-numbers', auth, { method: 'PUT', body: { phoneNumberId: id, businessType: business, label: label || undefined } })
            .then(() => { setId(''); setLabel(''); }), `That number is now answered by ${nameOf(business)}.`);
        }}>
          <div className="field grow">
            <label htmlFor="wa-id">Phone number ID</label>
            <input id="wa-id" className="input" inputMode="numeric" placeholder="e.g. 1234567890" value={id} onChange={e => setId(e.target.value.trim())} />
          </div>
          <div className="field grow">
            <label htmlFor="wa-biz">Business</label>
            <select id="wa-biz" className="input" value={business} onChange={e => setBusiness(e.target.value)}>
              <option value="">Choose…</option>
              {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="wa-label">Label (optional)</label>
            <input id="wa-label" className="input" placeholder="e.g. Main line" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <Button type="submit" busy={busy} disabled={!id || !business}>Add</Button>
        </form>
        <Status msg={msg} />
      </Card>
    </>
  );
}
