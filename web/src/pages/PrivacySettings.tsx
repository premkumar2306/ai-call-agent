import { useEffect, useState } from 'react';

// Settings → Privacy & data (India DPDP): call-start notice, privacy notice
// link, retention, and caller data export / erasure. Backed by
// /admin/privacy/:businessType/* in the worker (routes/privacy.ts).

interface Props {
  base: string;
  /** authHeaders(): the operator's admin key or an owner's sign-in. */
  auth: Record<string, string>;
  sectors: { key: string; name: string }[];
}

interface PrivacyState {
  aiDisclosure: boolean | null;
  disclosureEffective: boolean;
  inIndia: boolean;
  disclosureText: string | null;
  defaultDisclosureText: string;
  disclosureMaxChars: number;
  privacyNoticeUrl: string | null;
  retentionDays: number | null;
  retentionLimits: { min: number; max: number };
  consentLogMinDays: number;
}

interface NoticeRow { id: string; channel: string; call_sid: string | null; played_at: number; heard_fully: number | null; erased: number }

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20, marginTop: 16 };
const input: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, boxSizing: 'border-box' };
const label: React.CSSProperties = { display: 'block', fontSize: 13, color: '#ccc', margin: '14px 0 6px' };
const hint: React.CSSProperties = { fontSize: 12, color: '#777', margin: '4px 0 0' };
const btn = (disabled: boolean, danger = false): React.CSSProperties => ({
  background: danger ? '#b91c1c' : '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
});

type Mode = 'auto' | 'on' | 'off';
const toMode = (v: boolean | null): Mode => (v === null ? 'auto' : v ? 'on' : 'off');
const fromMode = (m: Mode): boolean | null => (m === 'auto' ? null : m === 'on');

export default function PrivacySettings({ base, auth, sectors }: Props) {
  const [business, setBusiness] = useState('');
  const [state, setState] = useState<PrivacyState | null>(null);
  const [mode, setMode] = useState<Mode>('auto');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [days, setDays] = useState('');
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('');
  const [reqMsg, setReqMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => { if (!business && sectors.length) setBusiness(sectors[0].key); }, [sectors, business]);

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}/admin/privacy/${encodeURIComponent(business)}${path}`, {
      ...init,
      headers: { ...auth, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json.data;
  };

  const load = async () => {
    try {
      const [s, n] = await Promise.all([api('/settings'), api('/notices?limit=20')]);
      setState(s);
      setMode(toMode(s.aiDisclosure));
      setText(s.disclosureText ?? '');
      setUrl(s.privacyNoticeUrl ?? '');
      setDays(s.retentionDays === null ? '' : String(s.retentionDays));
      setNotices(n);
    } catch (e: any) {
      setState(null);
      setMsg({ text: e.message === 'Admin key required' ? 'Sign in to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => {
    setMsg(null); setReqMsg(null);
    if (Object.keys(auth).length && business) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, base, business]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          aiDisclosure: fromMode(mode),
          disclosureText: text.trim() || null,
          privacyNoticeUrl: url.trim() || null,
          retentionDays: days.trim() ? Number(days) : null,
        }),
      });
      setMsg({ text: 'Saved. Takes effect on the next call (up to 5 minutes while the business cache refreshes).', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    setBusy(true); setReqMsg(null);
    try {
      const data = await api('/export', { method: 'POST', body: JSON.stringify({ phone }) });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `caller-data-${business}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setReqMsg({ text: `Exported ${data.transcripts.length} transcripts, ${data.messages.length} messages, ${data.bookings.length} bookings.`, ok: true });
    } catch (e: any) {
      setReqMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const erase = async () => {
    const typed = window.prompt(`This permanently deletes this caller's transcripts and messages for ${business}, removes their details from bookings, and cancels their upcoming bookings. Type the phone number again to confirm.`);
    if (typed === null) return;
    if (typed.replace(/\D/g, '') !== phone.replace(/\D/g, '')) { setReqMsg({ text: 'Numbers did not match — nothing was erased.', ok: false }); return; }
    setBusy(true); setReqMsg(null);
    try {
      const s = await api('/erase', { method: 'POST', body: JSON.stringify({ phone, confirm: true }) });
      setReqMsg({
        text: `Erased: ${s.transcriptsDeleted} transcripts, ${s.messagesDeleted} messages; ${s.bookingsAnonymised} bookings anonymised (${s.upcomingBookingsCancelled} upcoming cancelled).`,
        ok: true,
      });
      setPhone('');
    } catch (e: any) {
      setReqMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const daysNum = Number(days);
  const shortRetention = days.trim() !== '' && Number.isFinite(daysNum) && state && daysNum < state.consentLogMinDays;

  return (
    <>
      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Privacy &amp; data</h2>
        <p style={{ margin: '0 0 12px', color: '#888', fontSize: 13 }}>
          Call-start notice, privacy notice link and how long call data is kept. Built for India's DPDP Act;
          these settings help, but don't by themselves make a business compliant — see docs/compliance-india.md.
        </p>
        <select value={business} onChange={e => setBusiness(e.target.value)} style={{ ...input, minWidth: 220 }}>
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>

        {state && (
          <>
            <label style={label}>AI &amp; transcription notice at the start of each call</label>
            <select value={mode} onChange={e => setMode(e.target.value as Mode)} style={{ ...input, minWidth: 220 }}>
              <option value="auto">Automatic — {state.inIndia ? 'on (business is in India)' : 'off (business is not in India)'}</option>
              <option value="on">Always on</option>
              <option value="off">Off</option>
            </select>
            <p style={hint}>Currently <b style={{ color: state.disclosureEffective ? '#4ade80' : '#aaa' }}>{state.disclosureEffective ? 'on' : 'off'}</b>. Each time it plays is logged below.</p>

            <label style={label}>Notice wording (optional)</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={state.disclosureMaxChars}
              placeholder={state.defaultDisclosureText}
              rows={3}
              style={{ ...input, width: '100%', resize: 'vertical' }}
            />
            <p style={hint}>Leave empty for the default shown. Spoken right after “Thanks for calling!”; keep it short. {text.length}/{state.disclosureMaxChars}</p>

            <label style={label}>Privacy notice URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://yourbusiness.in/privacy" style={{ ...input, width: '100%' }} />
            <p style={hint}>Linked in booking confirmation texts and the first WhatsApp reply while the notice is on. Template: docs/privacy-notice-template.md.</p>

            <label style={label}>Keep transcripts and messages for (days)</label>
            <input value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} placeholder="Keep (no automatic deletion)" style={{ ...input, width: 220 }} />
            <p style={hint}>
              Deleted daily once older than this. Empty = keep. Bookings are kept; notice records are kept at least {state.consentLogMinDays} days.
            </p>
            {shortRetention && (
              <p style={{ ...hint, color: '#fbbf24' }}>
                The DPDP Rules 2025 (rule 8(3)) ask for certain personal data and logs to be kept at least one year. Check with your adviser before choosing a shorter period.
              </p>
            )}

            <div style={{ marginTop: 16 }}>
              <button onClick={save} disabled={busy} style={btn(busy)}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </>
        )}
        {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
      </div>

      {state && (
        <div style={card}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Caller data requests</h2>
          <p style={{ margin: '0 0 12px', color: '#888', fontSize: 13 }}>
            When a caller asks what you hold about them, or asks you to delete it. Enter their number with country code.
            Verify the request comes from the person (e.g. call them back on that number) before acting.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" style={{ ...input, width: 220 }} />
            <button onClick={exportData} disabled={busy || !phone.trim()} style={btn(busy || !phone.trim())}>Export (JSON)</button>
            <button onClick={erase} disabled={busy || !phone.trim()} style={btn(busy || !phone.trim(), true)}>Erase…</button>
          </div>
          {reqMsg && <p style={{ margin: '12px 0 0', fontSize: 13, color: reqMsg.ok ? '#4ade80' : '#f87171' }}>{reqMsg.text}</p>}

          <h3 style={{ margin: '20px 0 8px', fontSize: 14, color: '#ddd' }}>Recent notice records</h3>
          {notices.length === 0 ? (
            <p style={hint}>None yet.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 12, color: '#bbb', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#888' }}><th>When</th><th>Channel</th><th>Call</th><th>Heard fully</th></tr>
              </thead>
              <tbody>
                {notices.map(n => (
                  <tr key={n.id} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ padding: '4px 0' }}>{new Date(n.played_at * 1000).toLocaleString()}</td>
                    <td>{n.channel}</td>
                    <td>{n.call_sid ? `…${n.call_sid.slice(-8)}` : '—'}{n.erased ? ' (caller erased)' : ''}</td>
                    <td>{n.heard_fully === null ? '—' : n.heard_fully ? 'yes' : 'no (talked over / hung up)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
