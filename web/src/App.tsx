import { useState, useEffect, useMemo, useCallback } from 'react';
import Dashboard from './pages/Dashboard';
import VoiceTest from './pages/VoiceTest';
import WhatsApp from './pages/WhatsApp';
import Calls from './pages/Calls';
import Settings, { LocaleSettings } from './pages/Settings';
import Calendar from './pages/Calendar';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import Business from './pages/Business';
import Services from './pages/Services';
import Team from './pages/Team';
import { loadAdminKey, saveAdminKey } from './adminKey';
import { ApiError, api, authHeaders, loadOwnerToken, saveOwnerToken, type Auth, type Me } from './auth';

// Operator (admin key) sees every tab and every business; owners and staff see
// their own businesses, and staff only the tabs that don't change settings.
const ADMIN_TABS = ['Customize', 'Voice Test', 'Calls', 'Business', 'Services', 'Team', 'WhatsApp', 'Calendar', 'Settings', 'Overview'] as const;
const OWNER_TABS = ['Calls', 'Business', 'Services', 'Calendar', 'Team', 'Voice Test', 'Customize'] as const;
const STAFF_TABS = ['Calls', 'Business', 'Services', 'Voice Test'] as const;
type Tab = typeof ADMIN_TABS[number];

const BASE = import.meta.env.VITE_API_URL
  || 'https://mogi-platform.premkumar-2ba.workers.dev';

interface SectorOption { key: string; name: string }

// Calendar OAuth sends the browser back here with
// ?calendar=connected|error&business=<key>[&reason=…]. Read it once, then
// clear it from the address bar so a reload doesn't repeat the message.
function takeCalendarRedirect(): { business: string; ok: boolean; reason?: string } | null {
  const q = new URLSearchParams(window.location.search);
  const result = q.get('calendar');
  const business = q.get('business');
  if (!result || !business) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return { business, ok: result === 'connected', reason: q.get('reason') ?? undefined };
}
const calendarRedirect = takeCalendarRedirect();

const selectStyle: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '6px 12px', borderRadius: 8, outline: 'none', minWidth: 180 };
const linkBtn: React.CSSProperties = { background: 'none', border: '1px solid #2a2a3a', color: '#aaa', padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13 };

export default function App() {
  const [tab, setTab] = useState<Tab>(calendarRedirect ? 'Calendar' : 'Voice Test');
  const [sector, setSector] = useState<string>('');
  const [allSectors, setAllSectors] = useState<SectorOption[]>([]);
  const [adminKey, setAdminKey] = useState<string>(loadAdminKey);
  const [ownerToken, setOwnerToken] = useState<string>(loadOwnerToken);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState('');
  const [onboarding, setOnboarding] = useState(false);

  const auth: Auth = adminKey ? { kind: 'admin', key: adminKey } : ownerToken ? { kind: 'user', token: ownerToken } : null;
  // Memoised so pages' effects don't refire on every render.
  const headers = useMemo(() => authHeaders(auth), [adminKey, ownerToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateAdminKey = (key: string) => { setAdminKey(key); saveAdminKey(key); };
  const signOut = () => {
    if (ownerToken) fetch(`${BASE}/account/logout`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => {});
    saveOwnerToken(''); setOwnerToken(''); setMe(null);
    updateAdminKey('');
    setSector('');
  };

  // Operator: every business. Owner: just theirs, from /account/me.
  useEffect(() => {
    if (!adminKey) return;
    fetch(`${BASE}/sectors`)
      .then(r => r.json())
      .then(json => { if (json.success) setAllSectors(json.data); })
      .catch(() => {});
  }, [adminKey]);

  const loadMe = useCallback(async () => {
    if (!ownerToken || adminKey) return;
    try {
      setMe(await api<Me>(BASE, '/account/me', { Authorization: `Bearer ${ownerToken}` }));
      setMeError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { saveOwnerToken(''); setOwnerToken(''); setMe(null); }
      else setMeError((e as Error).message);
    }
  }, [ownerToken, adminKey]);
  useEffect(() => { loadMe(); }, [loadMe]);

  const sectors: SectorOption[] = adminKey ? allSectors : (me?.businesses ?? []);
  const role = adminKey ? 'admin' : me?.businesses.find(b => b.key === sector)?.role;
  const tabs: readonly Tab[] = role === 'admin' ? ADMIN_TABS : role === 'owner' ? OWNER_TABS : STAFF_TABS;

  // Keep the selected business (and tab) valid for whoever is signed in.
  useEffect(() => {
    if (!sectors.length) return;
    if (!sectors.some(s => s.key === sector)) {
      const preferred = calendarRedirect?.business ?? (adminKey ? 'advanced_vtech' : '');
      setSector((sectors.find(s => s.key === preferred) ?? sectors[0]).key);
    }
  }, [sectors, sector, adminKey]);
  useEffect(() => { if (role && !tabs.includes(tab)) setTab(tabs[0]); }, [role, tabs, tab]);

  const header = (right: React.ReactNode) => (
    <header style={{ background: '#12121a', borderBottom: '1px solid #222', padding: '16px 32px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: 0 }}>Avery</h1>
      <span style={{ background: '#6c47ff22', color: '#a78bff', padding: '2px 10px', borderRadius: 99, fontSize: 12, border: '1px solid #6c47ff44' }}>
        {adminKey ? 'Operator' : 'Business Dashboard'}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>
    </header>
  );
  const shell = (right: React.ReactNode, body: React.ReactNode) => (
    <div className="min-h-screen" style={{ background: '#0a0a0f', color: '#e0e0e0', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {header(right)}
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 24px', display: 'grid', gap: 24 }}>{body}</main>
    </div>
  );

  // ── Signed out ──
  if (!auth) {
    return shell(null, (
      <Login
        base={BASE}
        onSignedIn={(token, m) => { saveOwnerToken(token); setOwnerToken(token); setMe(m); setOnboarding(!m.businesses.length); }}
        onAdminKey={updateAdminKey}
      />
    ));
  }

  // ── Owner: loading, or no business yet → wizard ──
  if (auth.kind === 'user') {
    const signOutBtn = <button style={linkBtn} onClick={signOut}>Sign out</button>;
    if (!me) return shell(signOutBtn, <p style={{ color: meError ? '#f87171' : '#888' }}>{meError || 'Loading…'}</p>);
    if (onboarding || !me.businesses.length) {
      return shell(<><span style={{ fontSize: 13, color: '#888' }}>{me.user.email}</span>{signOutBtn}</>, (
        <Onboarding
          base={BASE}
          auth={headers}
          onCancel={me.businesses.length ? () => setOnboarding(false) : undefined}
          onCreated={async key => { await loadMe(); setSector(key); setOnboarding(false); setTab('Voice Test'); }}
        />
      ));
    }
  }

  const right = (
    <>
      {auth.kind === 'user' && <span style={{ fontSize: 13, color: '#888' }}>{me?.user.email}</span>}
      <label style={{ fontSize: 13, color: '#888' }}>Business</label>
      <select
        value={sector}
        onChange={e => (e.target.value === '__new' ? setOnboarding(true) : setSector(e.target.value))}
        style={selectStyle}
      >
        {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        {auth.kind === 'user' && <option value="__new">+ Add another business…</option>}
      </select>
      <button style={linkBtn} onClick={signOut}>Sign out</button>
    </>
  );

  return shell(right, (
    <>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: '#12121a', padding: 4, borderRadius: 10, width: 'fit-content', flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500,
              border: 'none', transition: 'all .15s',
              background: tab === t ? '#6c47ff' : 'transparent',
              color: tab === t ? '#fff' : '#888',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Customize' && <Dashboard sector={sector} base={BASE} auth={headers} />}
      {tab === 'Voice Test' && <VoiceTest sector={sector} base={BASE} />}
      {tab === 'Calls' && <Calls base={BASE} auth={headers} sectors={sectors} />}
      {tab === 'Business' && sector && <Business sector={sector} base={BASE} auth={headers} canEdit={role !== 'staff'} onRenamed={loadMe} />}
      {tab === 'Services' && sector && <Services sector={sector} base={BASE} auth={headers} canEdit={role !== 'staff'} />}
      {tab === 'Team' && sector && <Team sector={sector} base={BASE} auth={headers} myUserId={me?.user.id} />}
      {tab === 'WhatsApp' && <WhatsApp sector={sector} base={BASE} auth={headers} />}
      {tab === 'Calendar' && sector && (
        <Calendar
          key={sector}
          sector={sector}
          base={BASE}
          auth={headers}
          oauthResult={calendarRedirect?.business === sector ? calendarRedirect : null}
        />
      )}
      {tab === 'Settings' && (
        <div style={{ display: 'grid', gap: 24 }}>
          <Settings base={BASE} adminKey={adminKey} sectors={sectors} />
          <LocaleSettings base={BASE} adminKey={adminKey} sectors={sectors} />
        </div>
      )}
      {tab === 'Overview' && <Overview />}
    </>
  ));
}

function Overview() {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 20 }}>Quick Stats</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {[['2', 'Active Sectors'], ['9', 'Voice Tools'], ['200', 'Max Tokens / Turn']].map(([v, k]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{v}</span>
              <span style={{ fontSize: 13, color: '#888' }}>{k}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 12 }}>Twilio Setup</h2>
        <p style={{ fontSize: 14, color: '#888', lineHeight: 1.7 }}>
          Point your Twilio Voice webhook to:<br />
          <code style={{ color: '#a78bff', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
            {'POST https://<your-worker>.workers.dev/twilio/inbound?token=<jwt>'}
          </code>
          <br /><br />
          Each turn: Twilio STT →{' '}
          <code style={{ color: '#a78bff', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
            POST /twilio/turn
          </code>{' '}
          → Claude Haiku (200 tokens) → TwiML → Twilio TTS
        </p>
      </div>
    </div>
  );
}
