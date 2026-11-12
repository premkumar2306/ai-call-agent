import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, EmptyState, Status, Table } from '../components/ui';

// Operator → Phone numbers: owners' requests for a phone number.

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface RequestRow { id: string; businessType: string; requestedBy: string | null; note: string | null; status: string; createdAt: string | number }

// Owners' "Request a phone number" (/admin/number-requests).
export function NumberRequests({ base, adminKey, sectors }: Props) {
  const auth = { 'X-Admin-Key': adminKey };
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const nameOf = (key: string) => sectors.find(s => s.key === key)?.name ?? key;
  const load = () => api<RequestRow[]>(base, '/admin/number-requests', auth).then(setRows).catch(e => setMsg({ text: e.message, ok: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (adminKey) load(); }, [adminKey, base]);
  const setStatus = (r: RequestRow, status: 'open' | 'done') =>
    api(base, `/admin/number-requests/${r.id}`, auth, { method: 'PATCH', body: { status } }).then(load).catch(e => setMsg({ text: e.message, ok: false }));

  if (!adminKey) return null;
  const open = rows?.filter(r => r.status === 'open') ?? [];
  return (
    <Card
      title={<>Phone number requests {open.length > 0 && <Badge tone="warning">{open.length} open</Badge>}</>}
      description="Owners ask for a number at the end of sign-up. Connect a number below, then mark the request done."
    >
      {rows && !rows.length && <EmptyState title="No requests yet" />}
      {rows && rows.length > 0 && (
        <Table head={['Business', 'Requested by', 'Note', 'When', <span className="sr-only">Actions</span>]}>
          {rows.map(r => (
            <tr key={r.id} className={r.status === 'done' ? 'done' : undefined}>
              <td data-label="Business">{nameOf(r.businessType)}</td>
              <td data-label="Requested by">{r.requestedBy ?? ''}</td>
              <td className="dim" data-label="Note">{r.note ?? ''}</td>
              <td className="dim" data-label="When">{new Date(typeof r.createdAt === 'number' ? r.createdAt * 1000 : r.createdAt).toLocaleDateString()}</td>
              <td className="num">
                <Button variant="secondary" size="sm" onClick={() => setStatus(r, r.status === 'open' ? 'done' : 'open')}>
                  {r.status === 'open' ? 'Mark done' : 'Reopen'}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Status msg={msg} />
    </Card>
  );
}
