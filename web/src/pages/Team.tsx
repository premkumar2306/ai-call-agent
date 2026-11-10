import { useEffect, useState } from 'react';
import { api } from '../auth';
import { btn, card, ghost, h2, hint, input, msgStyle } from '../ui';

interface Props { sector: string; base: string; auth: Record<string, string>; myUserId?: string }
interface Member { userId: string; email: string; name: string | null; role: 'owner' | 'staff'; addedAt: string }

// Owners add people by email; they sign in with that address to get access.
// Staff see calls, bookings and messages; owners can also change settings,
// services, the calendar and the team.
export default function Team({ sector, base, auth, myUserId }: Props) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'staff' | 'owner'>('staff');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const path = `/account/businesses/${encodeURIComponent(sector)}/members`;

  const load = () => api<Member[]>(base, path, auth).then(setMembers).catch(e => setMsg({ text: e.message, ok: false }));
  useEffect(() => { setMembers(null); setMsg(null); load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sector, base, auth]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ text: ok, ok: true }); await load(); } catch (e: any) { setMsg({ text: e.message, ok: false }); } finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <h2 style={h2}>Team</h2>
      <p style={hint}>Add people by email — they sign in with that address. Staff can see calls, bookings and messages; owners can also change settings, services, the calendar and the team.</p>
      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}
        onSubmit={e => { e.preventDefault(); run(() => api(base, path, auth, { body: { email, role } }), `Added ${email.trim()}.`).then(() => setEmail('')); }}>
        <input style={{ ...input, flex: 1, minWidth: 220 }} type="email" required placeholder="colleague@example.com" value={email} onChange={e => setEmail(e.target.value)} />
        <select style={{ ...input, width: 110 }} value={role} onChange={e => setRole(e.target.value as 'staff' | 'owner')}>
          <option value="staff">Staff</option>
          <option value="owner">Owner</option>
        </select>
        <button style={btn} disabled={busy || !email}>Add</button>
      </form>
      {members?.map(m => (
        <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid #1e1e2e', padding: '10px 0' }}>
          <div style={{ flex: 1, fontSize: 14, color: '#fff' }}>
            {m.email}{m.userId === myUserId && <span style={{ color: '#888' }}> (you)</span>}
          </div>
          <select style={{ ...input, width: 110 }} value={m.role} disabled={busy}
            onChange={e => run(() => api(base, `${path}/${m.userId}`, auth, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated.')}>
            <option value="staff">Staff</option>
            <option value="owner">Owner</option>
          </select>
          <button style={{ ...ghost, padding: '4px 10px' }} disabled={busy}
            onClick={() => { if (confirm(`Remove ${m.email}?`)) run(() => api(base, `${path}/${m.userId}`, auth, { method: 'DELETE' }), `Removed ${m.email}.`); }}>
            Remove
          </button>
        </div>
      ))}
      {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
    </div>
  );
}
