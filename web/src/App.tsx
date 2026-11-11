import { useState, useEffect, useMemo, useCallback } from 'react';
import Dashboard from './pages/Dashboard';
import VoiceTest from './pages/VoiceTest';
import WhatsApp from './pages/WhatsApp';
import Calls from './pages/Calls';
import DefaultLine, { LocaleSettings } from './pages/Settings';
import Calendar from './pages/Calendar';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import Business from './pages/Business';
import Services from './pages/Services';
import Team from './pages/Team';
import Billing from './pages/Billing';
import Practitioners from './pages/Practitioners';
import PrivacySettings from './pages/PrivacySettings';
import VoiceSettings from './pages/VoiceSettings';
import PhoneNumbers from './pages/PhoneNumbers';
import PhoneNumber from './pages/PhoneNumber';
import Home from './pages/Home';
import { NumberRequests, WhatsAppNumbers } from './pages/Operator';
import { BUSINESS_KINDS, practitionerWords, verticalForKind } from './business';
import { loadAdminKey, saveAdminKey } from './adminKey';
import { ApiError, api, authHeaders, loadOwnerToken, saveOwnerToken, type Auth, type Me } from './auth';
import { Badge, Button, PageHeader, Segmented, Table } from './components/ui';

const BASE = import.meta.env.VITE_API_URL
  || 'https://mogi-platform.premkumar-2ba.workers.dev';

interface SectorOption { key: string; name: string; kind?: string | null }

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

// ── Routes ──────────────────────────────────────────────────────────────────
// Kept in the URL hash (#/calls, #/settings/privacy) so Back and reload work.

const SETTINGS = [
  { key: 'business', label: 'Business details' },
  { key: 'assistant', label: 'Assistant' },
  { key: 'phone', label: 'Phone number' },
  { key: 'privacy', label: 'Privacy' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'billing', label: 'Billing' },
] as const;
type SettingsKey = typeof SETTINGS[number]['key'];

const readHash = () => window.location.hash.replace(/^#\/?/, '');

interface NavItem { route: string; label: string; icon: string }

export default function App() {
  const [route, setRouteState] = useState<string>(calendarRedirect ? 'settings/calendar' : readHash());
  const [sector, setSector] = useState<string>('');
  const [allSectors, setAllSectors] = useState<SectorOption[]>([]);
  const [adminKey, setAdminKey] = useState<string>(loadAdminKey);
  const [ownerToken, setOwnerToken] = useState<string>(loadOwnerToken);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState('');
  const [onboarding, setOnboarding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const go = useCallback((r: string) => {
    setRouteState(r);
    setMenuOpen(false);
    if (readHash() !== r) window.history.pushState(null, '', `#/${r}`);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const onPop = () => setRouteState(readHash());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const auth: Auth = adminKey ? { kind: 'admin', key: adminKey } : ownerToken ? { kind: 'user', token: ownerToken } : null;
  // Memoised so pages' effects don't refire on every render.
  const headers = useMemo(() => authHeaders(auth), [adminKey, ownerToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateAdminKey = (key: string) => { setAdminKey(key); saveAdminKey(key); };
  const signOut = () => {
    if (ownerToken) fetch(`${BASE}/account/logout`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => {});
    saveOwnerToken(''); setOwnerToken(''); setMe(null);
    updateAdminKey('');
    setSector('');
    go('');
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
  const isOperator = role === 'admin';
  const canEdit = role === 'admin' || role === 'owner';
  const selected = sectors.find(s => s.key === sector);
  const words = selected?.kind !== undefined ? practitionerWords(verticalForKind(selected?.kind), selected?.kind) : null;
  // Owners manage sign-ins on the Team page too; staff only see the people list.
  const showTeam = !!words || canEdit;
  const one = useMemo(() => sectors.filter(s => s.key === sector), [sectors, sector]);

  // Keep the selected business valid for whoever is signed in.
  useEffect(() => {
    if (!sectors.length) return;
    if (!sectors.some(s => s.key === sector)) {
      const preferred = calendarRedirect?.business ?? (adminKey ? 'advanced_vtech' : '');
      setSector((sectors.find(s => s.key === preferred) ?? sectors[0]).key);
    }
  }, [sectors, sector, adminKey]);

  // ── Navigation for this role ──
  const businessNav: NavItem[] = [
    { route: 'home', label: 'Home', icon: '⌂' },
    { route: 'calls', label: 'Calls & messages', icon: '☎' },
    { route: 'appointments', label: 'Appointments', icon: '▦' },
    ...(showTeam ? [{ route: 'team', label: words?.many ?? 'Team', icon: '☺' }] : []),
    { route: 'services', label: 'Services & prices', icon: '☰' },
    { route: 'try', label: 'Try your assistant', icon: '▶' },
    ...(canEdit ? [{ route: 'settings', label: 'Settings', icon: '⚙' }] : []),
  ];
  const operatorNav: NavItem[] = [
    { route: 'op/businesses', label: 'All businesses', icon: '▤' },
    { route: 'op/numbers', label: 'Phone numbers', icon: '☏' },
    { route: 'op/whatsapp', label: 'WhatsApp', icon: '✉' },
    { route: 'op/plans', label: 'Plans & billing', icon: '₹' },
  ];
  const allowed = [...businessNav, ...(isOperator ? operatorNav : [])];
  const fallback = isOperator ? 'op/businesses' : 'home';
  const top = route.startsWith('op/') ? route : route.split('/')[0];
  const current = allowed.some(n => n.route === top) ? route : fallback;
  const currentTop = current.startsWith('op/') ? current : current.split('/')[0];
  const settingsKey = (current.split('/')[1] as SettingsKey) || 'business';
  const pageTitle = allowed.find(n => n.route === currentTop)?.label ?? '';

  // ── Signed out ──
  if (!auth) {
    return (
      <main className="auth-wrap">
        <div>
          <div className="brand" style={{ justifyContent: 'center', paddingBottom: 20 }}><span className="brand-mark" aria-hidden="true">A</span>Avery</div>
          <Login
            base={BASE}
            onSignedIn={(token, m) => { saveOwnerToken(token); setOwnerToken(token); setMe(m); setOnboarding(!m.businesses.length); go('home'); }}
            onAdminKey={key => { updateAdminKey(key); go('op/businesses'); }}
          />
        </div>
      </main>
    );
  }

  // ── Owner: loading, or no business yet → wizard ──
  if (auth.kind === 'user') {
    if (!me) {
      return (
        <main className="auth-wrap">
          <div className="stack">
            <p className={meError ? '' : 'muted'} role="status" style={meError ? { color: 'var(--danger)' } : undefined}>{meError || 'Loading…'}</p>
            <div><Button variant="secondary" onClick={signOut}>Sign out</Button></div>
          </div>
        </main>
      );
    }
    if (onboarding || !me.businesses.length) {
      return (
        <main className="auth-wrap" style={{ placeItems: 'start center' }}>
          <div className="stack" style={{ maxWidth: 760 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="brand" style={{ padding: 0 }}><span className="brand-mark" aria-hidden="true">A</span>Avery</div>
              <div className="row"><span className="muted" style={{ fontSize: 14 }}>{me.user.email}</span><Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button></div>
            </div>
            <Onboarding
              base={BASE}
              auth={headers}
              onCancel={me.businesses.length ? () => setOnboarding(false) : undefined}
              onCreated={async key => { await loadMe(); setSector(key); setOnboarding(false); go('home'); }}
            />
          </div>
        </main>
      );
    }
  }

  const navButton = (n: NavItem) => (
    <button key={n.route} type="button" className="nav-item" aria-current={currentTop === n.route ? 'page' : undefined} onClick={() => go(n.route)}>
      <span className="nav-icon" aria-hidden="true">{n.icon}</span>{n.label}
    </button>
  );

  const businessPicker = (sectors.length > 1 || auth.kind === 'user') && (
    <div style={{ padding: '0 6px 8px' }}>
      <label htmlFor="business-picker" className="nav-group" style={{ display: 'block', padding: '0 4px 4px' }}>{isOperator ? 'Managing' : 'Business'}</label>
      <select
        id="business-picker"
        className="input"
        value={sector}
        onChange={e => (e.target.value === '__new' ? setOnboarding(true) : (setSector(e.target.value), go(isOperator && currentTop.startsWith('op/') ? 'home' : current)))}
      >
        {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        {auth.kind === 'user' && <option value="__new">+ Add another business…</option>}
      </select>
    </div>
  );

  const sidebar = (
    <aside className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Main menu">
      <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>Avery{isOperator && <Badge tone="accent">Operator</Badge>}</div>
      <nav className="nav" aria-label="Main">
        {isOperator && <><div className="nav-group">Operator</div>{operatorNav.map(navButton)}<div className="nav-group" style={{ paddingTop: 18 }}>This business</div></>}
        {businessPicker}
        {businessNav.map(navButton)}
      </nav>
      <div className="sidebar-foot">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 8px' }}>
          {isOperator ? 'Signed in with the admin key' : me?.user.email}
          {!isOperator && role && <> · {role === 'owner' ? 'Owner' : 'Staff'}</>}
        </span>
        <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
      </div>
    </aside>
  );

  const bottomItems = (isOperator
    ? [operatorNav[0], businessNav[0], businessNav[1], businessNav.find(n => n.route === 'try')!]
    : [businessNav[0], businessNav[1], businessNav[2], businessNav.find(n => n.route === 'try')!]);

  return (
    <div className="app">
      <a href="#main" className="sr-only">Skip to content</a>
      {sidebar}
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <div className="content">
        <div className="topbar">
          <button type="button" data-shot-menu className="btn btn-secondary btn-sm" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰ Menu</button>
          <span className="title">{pageTitle}</span>
          {selected && <span className="muted" style={{ fontSize: 13, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name}</span>}
        </div>
        <main id="main" className="page">
          {sector && current === 'home' && (
            <Home key={sector} sector={sector} name={selected?.name ?? ''} base={BASE} auth={headers} isOwner={canEdit} go={go} />
          )}
          {sector && current === 'calls' && <>
            <PageHeader title="Calls & messages" description="Everyone who called or messaged on WhatsApp, and who is waiting for a call back." />
            <Calls key={sector} base={BASE} auth={headers} sectors={one} view="calls" />
          </>}
          {sector && current === 'appointments' && <>
            <PageHeader title="Appointments" description="Appointments the assistant booked for you." />
            <Calls key={sector} base={BASE} auth={headers} sectors={one} view="appointments" />
          </>}
          {sector && current === 'team' && <>
            <PageHeader title={words?.many ?? 'Team'} description={words ? `The ${words.many.toLowerCase()} callers can book, and their hours and fees.` : 'People who can sign in to this business.'} />
            {words && <Practitioners key={sector} sector={sector} base={BASE} auth={headers} canEdit={canEdit} />}
            {canEdit && <Team key={`${sector}-members`} sector={sector} base={BASE} auth={headers} myUserId={me?.user.id} />}
          </>}
          {sector && current === 'services' && <>
            <PageHeader title="Services & prices" description="What callers can book, how long it takes and what it costs. The assistant quotes these prices." />
            <Services key={sector} sector={sector} base={BASE} auth={headers} canEdit={canEdit} />
          </>}
          {sector && current === 'try' && <>
            <PageHeader title="Try your assistant" description="Talk or type as a caller would. Nothing here is a real call, but bookings you make are saved like real ones." />
            <VoiceTest sector={sector} base={BASE} operator={isOperator} />
          </>}
          {sector && currentTop === 'settings' && <>
            <PageHeader title="Settings" />
            <Segmented label="Settings sections" items={SETTINGS.map(s => ({ ...s }))} value={settingsKey} onChange={k => go(`settings/${k}`)} />
            <div key={`${sector}-${settingsKey}`} className="stack">
              {settingsKey === 'business' && <>
                <Business sector={sector} base={BASE} auth={headers} canEdit={canEdit} onRenamed={loadMe} />
                <details className="more card">
                  <summary>How prices, dates and phone numbers are written</summary>
                  <div style={{ marginTop: 12 }}><LocaleSettings base={BASE} auth={headers} sectors={one} /></div>
                </details>
              </>}
              {settingsKey === 'assistant' && <>
                <Dashboard sector={sector} base={BASE} auth={headers} canEdit={canEdit} operator={isOperator} />
                <VoiceSettings base={BASE} auth={headers} sectors={one} />
              </>}
              {settingsKey === 'phone' && <PhoneNumber sector={sector} base={BASE} auth={headers} canEdit={canEdit} onTry={() => go('try')} />}
              {settingsKey === 'privacy' && <PrivacySettings base={BASE} auth={headers} sectors={one} />}
              {settingsKey === 'calendar' && (
                <Calendar sector={sector} base={BASE} auth={headers} oauthResult={calendarRedirect?.business === sector ? calendarRedirect : null} />
              )}
              {settingsKey === 'billing' && <Billing sector={sector} base={BASE} auth={headers} />}
            </div>
          </>}

          {/* ── Operator area ── */}
          {isOperator && current === 'op/businesses' && <>
            <PageHeader title="All businesses" description="Every business on this deployment. Choose one to see its calls, settings and billing." />
            <section className="card">
              <Table head={['Business', 'Type', 'Key', '']}>
                {allSectors.map(s => (
                  <tr key={s.key}>
                    <td style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</td>
                    <td>{s.kind ? BUSINESS_KINDS[s.kind] ?? s.kind : '—'}</td>
                    <td><code>{s.key}</code></td>
                    <td style={{ textAlign: 'right' }}><Button size="sm" variant="secondary" onClick={() => { setSector(s.key); go('home'); }}>Manage</Button></td>
                  </tr>
                ))}
              </Table>
            </section>
          </>}
          {isOperator && current === 'op/numbers' && <>
            <PageHeader title="Phone numbers" description="Which business answers each number, and owners waiting for one." />
            <NumberRequests base={BASE} adminKey={adminKey} sectors={sectors} />
            <PhoneNumbers base={BASE} adminKey={adminKey} sectors={sectors} />
            <DefaultLine base={BASE} adminKey={adminKey} sectors={sectors} />
          </>}
          {isOperator && current === 'op/whatsapp' && <>
            <PageHeader title="WhatsApp" description="Which business answers each WhatsApp number, and recent WhatsApp chats." />
            <WhatsAppNumbers base={BASE} adminKey={adminKey} sectors={sectors} />
            {sector && <WhatsApp key={sector} sector={sector} base={BASE} auth={headers} />}
          </>}
          {isOperator && current === 'op/plans' && sector && <>
            <PageHeader title="Plans & billing" description={<>Plans, the plan new businesses start on, and costs. Usage and invoices below are for <b>{selected?.name}</b>.</>} />
            <Billing key={sector} sector={sector} base={BASE} auth={headers} />
          </>}
        </main>
      </div>
      <nav className="bottom-bar" aria-label="Quick">
        {bottomItems.map(n => (
          <button key={n.route} type="button" aria-current={currentTop === n.route ? 'page' : undefined} onClick={() => go(n.route)}>
            <span className="ico" aria-hidden="true">{n.icon}</span>{n.route === 'try' ? 'Try' : n.route === 'calls' ? 'Calls' : n.route === 'op/businesses' ? 'Businesses' : n.label}
          </button>
        ))}
        <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><span className="ico" aria-hidden="true">☰</span>More</button>
      </nav>
    </div>
  );
}
