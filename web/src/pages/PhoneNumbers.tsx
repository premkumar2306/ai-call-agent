import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Status, Table } from '../components/ui';

// Called number → business (admin API /admin/phone-numbers). A mapped number
// answers as its business on Twilio, Exotel or Plivo; unmapped numbers fall
// back to the "Phone line" default above (Twilio) or the carrier's
// *_DEFAULT_BUSINESS_TYPE (Exotel/Plivo).

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface Row { number: string; provider: string; businessType: string; label: string | null }

const PROVIDERS = [
  { key: 'exotel', name: 'Exotel (India)' },
  { key: 'twilio', name: 'Twilio' },
  { key: 'plivo', name: 'Plivo (India)' },
];


export default function PhoneNumbers({ base, adminKey, sectors }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [number, setNumber] = useState('');
  const [provider, setProvider] = useState('exotel');
  const [business, setBusiness] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;
  const providerName = (key: string) => PROVIDERS.find(p => p.key === key)?.name ?? key;

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json.data;
  };

  const load = async () => {
    try {
      setRows(await call('/admin/phone-numbers'));
    } catch (e: any) {
      setRows(null);
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => { setMsg(null); if (adminKey) load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminKey, base]);

  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      const saved: Row = await call('/admin/phone-numbers', {
        method: 'PUT',
        body: JSON.stringify({ number, provider, businessType: business, label: label || undefined }),
      });
      setMsg({ text: `${saved.number} (${providerName(saved.provider)}) now answers as ${nameOf(saved.businessType)}.`, ok: true });
      setNumber(''); setLabel('');
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Row) => {
    if (!confirm(`Unmap ${row.number}? Calls to it will fall back to the default business.`)) return;
    setBusy(true); setMsg(null);
    try {
      await call(`/admin/phone-numbers/${row.provider}/${encodeURIComponent(row.number)}`, { method: 'DELETE' });
      setMsg({ text: `${row.number} unmapped.`, ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (!adminKey) return null;

  return (
    <Card title="Phone numbers" description="Which business answers each number. A routed number overrides the default line. Indian numbers (Exotel or Plivo) can be typed as 080…, 98… or +91….">
      {rows && rows.length === 0 && <EmptyState title="No numbers routed yet">Add a number below once the carrier has connected it.</EmptyState>}
      {rows && rows.length > 0 && (
        <Table head={['Number', 'Carrier', 'Business', 'Label', <span className="sr-only">Actions</span>]}>
          {rows.map(r => (
            <tr key={`${r.provider}:${r.number}`}>
              <td className="mono" data-label="Number">{r.number}</td>
              <td data-label="Carrier">{providerName(r.provider)}</td>
              <td data-label="Business">{nameOf(r.businessType)}</td>
              <td className="dim" data-label="Label">{r.label ?? ''}</td>
              <td className="num"><Button variant="danger" size="sm" onClick={() => remove(r)} disabled={busy}>Remove</Button></td>
            </tr>
          ))}
        </Table>
      )}
      <form className="form-row" onSubmit={e => { e.preventDefault(); add(); }}>
        <div className="field grow"><label htmlFor="pn-number">Number</label><input id="pn-number" className="input" placeholder="+91 80 4712 3456" value={number} onChange={e => setNumber(e.target.value)} /></div>
        <div className="field grow"><label htmlFor="pn-carrier">Carrier</label>
          <select id="pn-carrier" className="input" value={provider} onChange={e => setProvider(e.target.value)}>
            {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </div>
        <div className="field grow"><label htmlFor="pn-biz">Business</label>
          <select id="pn-biz" className="input" value={business} onChange={e => setBusiness(e.target.value)}>
            <option value="">Choose…</option>
            {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </div>
        <div className="field grow"><label htmlFor="pn-label">Label (optional)</label><input id="pn-label" className="input" value={label} onChange={e => setLabel(e.target.value)} /></div>
        <Button type="submit" busy={busy} disabled={!rows || !number.trim() || !business}>Add number</Button>
      </form>
      <Status msg={msg} />
    </Card>
  );
}
