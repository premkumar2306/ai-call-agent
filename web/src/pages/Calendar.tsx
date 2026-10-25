import { useEffect, useState } from 'react';

interface Props {
  sector: string;
  base: string;
  adminKey: string;
  /** Result of the OAuth round trip, from the URL the provider sent us back to. */
  oauthResult?: { ok: boolean; reason?: string } | null;
}

interface Provider { id: string; name: string; configured: boolean }
interface Connection {
  provider: string;
  accountEmail: string | null;
  calendarId: string;
  calendarName: string | null;
  checkBusy: boolean;
  writeEvents: boolean;
  status: 'active' | 'reauth_required' | string;
  lastError: string | null;
  updatedAt: string;
}
interface CalendarOption { id: string; name: string; primary: boolean }

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };
const btn: React.CSSProperties = { background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer' };
const ghost: React.CSSProperties = { background: 'transparent', color: '#a78bff', border: '1px solid #6c47ff66', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' };
const select: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, minWidth: 260 };

export default function Calendar({ sector, base, adminKey, oauthResult }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [conn, setConn] = useState<Connection | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(
    oauthResult ? { text: oauthResult.ok ? 'Calendar connected.' : `Couldn't connect: ${oauthResult.reason ?? 'unknown error'}`, ok: oauthResult.ok } : null,
  );

  const headers = { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' };

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/admin/calendar/${encodeURIComponent(sector)}${path}`, { ...init, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json.data;
  };

  const load = async () => {
    setLoaded(false);
    try {
      const data = await call('');
      setProviders(data.providers);
      setConn(data.connection);
      setCalendars([]);
      if (data.connection?.status === 'active') {
        call('/calendars').then(setCalendars).catch((e: Error) => setMsg({ text: e.message, ok: false }));
      }
    } catch (e: any) {
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false });
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (!adminKey) { setMsg({ text: 'Enter the admin key (top right) to manage this.', ok: false }); return; }
    if (sector) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey, base, sector]);

  const connect = async (provider: string) => {
    setBusy(true); setMsg(null);
    try {
      // Come back to this page, minus any previous OAuth result params.
      const returnTo = `${window.location.origin}${window.location.pathname}`;
      const { url } = await call(`/${provider}/connect`, { method: 'POST', body: JSON.stringify({ returnTo }) });
      window.location.href = url;
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
      setBusy(false);
    }
  };

  const save = async (patch: Partial<Connection>, okText: string) => {
    setBusy(true); setMsg(null);
    try {
      await call('', { method: 'PUT', body: JSON.stringify(patch) });
      setMsg({ text: okText, ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setMsg(null);
    try {
      await call('', { method: 'DELETE' });
      setMsg({ text: 'Calendar disconnected.', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const providerName = (id: string) => providers.find(p => p.id === id)?.name ?? id;

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Calendar</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        Connect this business's calendar. Mogi won't offer times that are busy there, and adds each booking as an event (removed again if cancelled).
      </p>

      {loaded && !conn && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {providers.map(p => (
            <button key={p.id} onClick={() => connect(p.id)} disabled={busy || !p.configured}
              title={p.configured ? '' : 'Not configured on this deployment'}
              style={{ ...btn, opacity: busy || !p.configured ? 0.5 : 1 }}>
              Connect {p.name}
            </button>
          ))}
          {providers.length > 0 && providers.every(p => !p.configured) && (
            <p style={{ margin: 0, fontSize: 13, color: '#888', alignSelf: 'center' }}>
              No calendar provider is configured on this deployment yet.
            </p>
          )}
        </div>
      )}

      {conn && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#aaa' }}>
            Connected to <b style={{ color: '#fff' }}>{providerName(conn.provider)}</b>
            {conn.accountEmail ? <> as <b style={{ color: '#fff' }}>{conn.accountEmail}</b></> : null}
          </p>

          {conn.status === 'reauth_required' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#f87171' }}>Access was revoked or expired — bookings aren't syncing.</span>
              <button onClick={() => connect(conn.provider)} disabled={busy} style={btn}>Reconnect</button>
            </div>
          )}

          <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#888' }}>
            Calendar to use
            <select
              style={select}
              value={conn.calendarId}
              disabled={busy || !calendars.length}
              onChange={e => {
                const c = calendars.find(x => x.id === e.target.value);
                if (c) save({ calendarId: c.id, calendarName: c.name }, `Using “${c.name}”.`);
              }}
            >
              {!calendars.some(c => c.id === conn.calendarId) && (
                <option value={conn.calendarId}>{conn.calendarName ?? conn.calendarId}</option>
              )}
              {calendars.map(c => <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (primary)' : ''}</option>)}
            </select>
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#ddd' }}>
            <input type="checkbox" checked={conn.checkBusy} disabled={busy}
              onChange={e => save({ checkBusy: e.target.checked }, e.target.checked ? 'Busy times will be skipped.' : 'Busy times are ignored.')} />
            Don't offer times that are busy in this calendar
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#ddd' }}>
            <input type="checkbox" checked={conn.writeEvents} disabled={busy}
              onChange={e => save({ writeEvents: e.target.checked }, e.target.checked ? 'Bookings will be added to the calendar.' : 'Bookings won’t be added.')} />
            Add bookings to this calendar
          </label>

          {conn.lastError && conn.status === 'active' && (
            <p style={{ margin: 0, fontSize: 12, color: '#fbbf24' }}>Last problem: {conn.lastError}</p>
          )}

          <div>
            <button onClick={disconnect} disabled={busy} style={ghost}>Disconnect</button>
          </div>
        </div>
      )}

      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
  );
}
