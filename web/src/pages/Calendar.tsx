import { useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, Status, NotAvailable } from '../components/ui';

interface Props {
  sector: string;
  base: string;
  auth: Record<string, string>;
  /** Result of the OAuth round trip, from the URL the provider sent us back to. */
  oauthResult?: { ok: boolean; reason?: string } | null;
  canEdit?: boolean;
  /** Operator: when Google isn't set up, show which Worker settings are missing. */
  operator?: boolean;
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


export default function Calendar({ sector, base, auth, oauthResult, canEdit = true, operator = false }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [conn, setConn] = useState<Connection | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(
    oauthResult ? { text: oauthResult.ok ? 'Calendar connected.' : `Couldn't connect: ${oauthResult.reason ?? 'unknown error'}`, ok: oauthResult.ok } : null,
  );

  const headers = { ...auth, 'Content-Type': 'application/json' };

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
      setMsg({ text: e.message, ok: false });
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (!Object.keys(auth).length) return;
    if (sector) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, base, sector]);

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
  const available = providers.filter(p => p.configured);

  return (
    <Card
      className="card-accent"
      title={<>Google Calendar {loaded && (conn ? (conn.status === 'active' ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Needs reconnecting</Badge>) : <Badge>Not connected</Badge>)}</>}
      description="Connect your calendar so the assistant never offers a time you're busy, and every booking appears in your calendar (removed again if cancelled)."
    >
      {!loaded && <p className="muted" role="status">Loading…</p>}

      {loaded && !conn && available.length > 0 && (
        canEdit ? (
          <div className="row">
            {available.map(p => <Button key={p.id} onClick={() => connect(p.id)} busy={busy}>Connect {p.name}</Button>)}
          </div>
        ) : <p className="muted">Ask the business owner to connect the calendar.</p>
      )}

      {loaded && !conn && available.length === 0 && (operator ? (
        <Notice tone="warning">
          <div className="stack-sm">
            <strong>Google Calendar isn't set up on this deployment.</strong>
            <span>Add these Worker settings, then reload this page:</span>
            <ul className="plain-list">
              <li><code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>: an OAuth client (type “Web application”) in Google Cloud, with the Calendar API enabled</li>
              <li><code>CALENDAR_TOKEN_KEY</code>: a random key that encrypts the stored calendar tokens</li>
              <li>Authorised redirect URI on that client: <code>{base}/oauth/google/callback</code></li>
            </ul>
            <span>See “Calendar integration” in the README.</span>
          </div>
        </Notice>
      ) : (
        <NotAvailable feature="Google Calendar">The Avery team is setting it up. You'll be able to connect it here once it's ready.</NotAvailable>
      ))}

      {conn && (
        <div className="stack">
          <p>
            Connected to <span className="strong">{providerName(conn.provider)}</span>
            {conn.accountEmail ? <> as <span className="strong">{conn.accountEmail}</span></> : null}
          </p>

          {conn.status === 'reauth_required' && (
            <div className="row">
              <span className="bad">Access was revoked or expired, so bookings aren't syncing.</span>
              {canEdit && <Button onClick={() => connect(conn.provider)} busy={busy}>Reconnect</Button>}
            </div>
          )}

          {canEdit && (
            <>
              <div className="field">
                <label htmlFor="cal-pick">Calendar to use</label>
                <select
                  id="cal-pick"
                  className="input"
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
              </div>
              <label className="check-row">
                <input type="checkbox" checked={conn.checkBusy} disabled={busy}
                  onChange={e => save({ checkBusy: e.target.checked }, e.target.checked ? 'Busy times will be skipped.' : 'Busy times are ignored.')} />
                Don't offer times that are busy in this calendar
              </label>
              <label className="check-row">
                <input type="checkbox" checked={conn.writeEvents} disabled={busy}
                  onChange={e => save({ writeEvents: e.target.checked }, e.target.checked ? 'Bookings will be added to the calendar.' : 'Bookings won’t be added.')} />
                Add bookings to this calendar
              </label>
            </>
          )}

          {conn.lastError && conn.status === 'active' && <p className="warn small">Last problem: {conn.lastError}</p>}

          {canEdit && <div><Button variant="danger" onClick={disconnect} busy={busy}>Disconnect</Button></div>}
        </div>
      )}

      <Status msg={msg} />
    </Card>
  );
}
