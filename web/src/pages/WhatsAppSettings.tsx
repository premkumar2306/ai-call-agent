import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Card, Notice, Status } from '../components/ui';

// Owner Settings → WhatsApp: whether the business has a WhatsApp number
// (connected by the Avery team, read-only here), the reminder and
// missed-call follow-up switches (both off until turned on), and what each
// message says, in the business's language.

interface Data {
  connected: boolean;
  number: { displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null } | null;
  settings: { reminders: boolean; missedCallFollowup: boolean };
  ready: Record<string, boolean>;
  previews: Record<'confirmation' | 'reminder' | 'cancellation' | 'missed_call', string>;
}

const PREVIEWS: { key: keyof Data['previews']; label: string }[] = [
  { key: 'reminder', label: 'Reminder, a day before' },
  { key: 'missed_call', label: 'After a missed call' },
  { key: 'confirmation', label: 'Booking confirmed' },
  { key: 'cancellation', label: 'Booking cancelled' },
];

export default function WhatsAppSettings({ base, auth, sector, name }: { base: string; auth: Record<string, string>; sector: string; name: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/admin/whatsapp/business/${encodeURIComponent(sector)}`;

  useEffect(() => { api<Data>(base, path, auth).then(setData).catch(e => setMsg({ text: e.message, ok: false })); }, [base, path, auth]);

  const save = async (patch: Partial<Data['settings']>) => {
    if (!data) return;
    setBusy(true); setMsg(null);
    try {
      const settings = await api<Data['settings']>(base, path, auth, { method: 'PUT', body: patch });
      setData({ ...data, settings });
      setMsg({ text: 'Saved.', ok: true });
    } catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  if (!data) return <Card title="WhatsApp">{msg ? <Status msg={msg} /> : <p className="muted" role="status">Loading…</p>}</Card>;
  const n = data.number;
  return (
    <>
      <Card title="Your WhatsApp number" description="Customers can chat with your assistant on WhatsApp: the same services, hours and bookings as on calls.">
        {data.connected && n ? (
          <ul className="checklist">
            <li>
              <span className="check done" aria-hidden="true">✓</span>
              <div className="what">{n.displayPhoneNumber ?? 'Connected'}<span>{n.verifiedName ? `Shown to customers as “${n.verifiedName}”.` : 'Display name not checked yet.'}</span></div>
              {n.qualityRating === 'YELLOW' || n.qualityRating === 'RED'
                ? <Badge tone={n.qualityRating === 'RED' ? 'danger' : 'warning'}>Quality {n.qualityRating === 'RED' ? 'low' : 'medium'}</Badge>
                : <Badge tone="success">Connected</Badge>}
            </li>
          </ul>
        ) : (
          <p className="muted">No WhatsApp number yet. Ask the Avery team to connect your WhatsApp Business number; it then appears here.</p>
        )}
        {(n?.qualityRating === 'YELLOW' || n?.qualityRating === 'RED') && (
          <Notice tone="warning">Meta says some customers blocked or reported your messages. Keep reminders on only if your customers expect them.</Notice>
        )}
      </Card>

      <Card title="Automatic messages" description="Sent from your WhatsApp number. Both are off until you turn them on. Anyone who replies STOP (or बंद करो) gets no more of them.">
        <label className="switch-row">
          <input type="checkbox" checked={data.settings.reminders} disabled={busy} onChange={e => save({ reminders: e.target.checked })} />
          <span className="what">
            <span className="strong">Appointment reminders</span>
            <span className="muted small">A day before each booking. {data.ready.reminder ? '' : 'Until the WhatsApp reminder is approved by Meta, reminders go by SMS where available.'}</span>
          </span>
        </label>
        <label className="switch-row">
          <input type="checkbox" checked={data.settings.missedCallFollowup} disabled={busy} onChange={e => save({ missedCallFollowup: e.target.checked })} />
          <span className="what">
            <span className="strong">Missed-call follow-up</span>
            <span className="muted small">
              When a caller hangs up early or leaves a message, invite them to continue on WhatsApp. At most once a week per caller.
              {data.ready.missed_call ? '' : ' Starts once the Avery team has this message approved by Meta.'}
            </span>
          </span>
        </label>
        {!data.connected && (data.settings.reminders || data.settings.missedCallFollowup) && (
          <p className="muted small">No WhatsApp number yet: reminders go by SMS where available, and follow-ups wait for a number.</p>
        )}
        <p className="muted small">Meta's rules: only message people who expect it. Tell callers they may get a WhatsApp message about their booking, for example in your call greeting or privacy notice.</p>
        <Status msg={msg} />
      </Card>

      <Card title="What customers see" description={`In ${name}'s language. Times and services are examples.`}>
        <div className="wa-previews">
          {PREVIEWS.map(p => (
            <div key={p.key} className="wa-preview">
              <span className="small strong">{p.label}</span>
              <div className="bubble them">{data.previews[p.key]}</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
