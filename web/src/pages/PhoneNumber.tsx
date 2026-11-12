import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, Notice } from '../components/ui';

interface Request { id: string; status: 'open' | 'done'; createdAt: string }

// The owner's view of their phone number: the Avery team connects it, the
// owner asks for one (GET|POST /account/businesses/:key/number-request).
export default function PhoneNumber({ sector, base, auth, canEdit, onTry }: {
  sector: string; base: string; auth: Record<string, string>; canEdit: boolean; onTry: () => void;
}) {
  const [rows, setRows] = useState<Request[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/account/businesses/${encodeURIComponent(sector)}/number-request`;

  const load = () => api<Request[]>(base, path, auth).then(setRows).catch(e => setMsg({ text: e.message, ok: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); setMsg(null); load(); }, [sector, base, auth]);

  const request = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ alreadyRequested: boolean }>(base, path, auth, { body: {} });
      setMsg({ text: r.alreadyRequested ? 'You have already asked. The Avery team will be in touch.' : 'Request sent. The Avery team will contact you to connect a number.', ok: true });
      await load();
    } catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  const latest = rows?.[0];
  return (
    <Card title="Phone number" description="Callers reach your assistant on a phone number that the Avery team connects for you. Until then you can try it here in the app.">
      <div className="stack">
        {!rows ? <p className="muted" role="status">Loading…</p> : (
          <div className="row">
            <span>Status:</span>
            {!latest && <Badge>Not requested yet</Badge>}
            {latest?.status === 'open' && <Badge tone="warning">Requested on {new Date(latest.createdAt).toLocaleDateString()}, waiting for the Avery team</Badge>}
            {latest?.status === 'done' && <Badge tone="success">Connected</Badge>}
          </div>
        )}
        <div className="row">
          {canEdit && rows && latest?.status !== 'open' && latest?.status !== 'done' && <Button onClick={request} busy={busy}>Request a phone number</Button>}
          <Button variant="secondary" onClick={onTry}>Try your assistant</Button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Calls the assistant can't handle are transferred to the staff phone in Business details.
        </p>
        {msg && <Notice tone={msg.ok ? 'success' : 'error'}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}
