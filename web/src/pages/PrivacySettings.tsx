import { useEffect, useState } from 'react';
import { Button, Card, Status, Table } from '../components/ui';

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
  legal?: boolean;
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
      <Card
        title="Privacy notice and data"
        description="What callers are told at the start of a call, your privacy notice link, and how long call records are kept. These help with India's data protection law (DPDP Act) but don't on their own make a business compliant."
      >
        {sectors.length > 1 && (
          <div className="field">
            <label htmlFor="pv-biz">Business</label>
            <select id="pv-biz" className="input" value={business} onChange={e => setBusiness(e.target.value)}>
              {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </div>
        )}

        {state && (
          <>
            <div className="field">
              <label htmlFor="pv-mode">AI &amp; transcription notice at the start of each call</label>
              <select id="pv-mode" className="input" value={mode} onChange={e => setMode(e.target.value as Mode)}>
                <option value="auto">Automatic — {state.inIndia ? 'on (business is in India)' : state.legal ? 'on (law firm)' : 'off (business is not in India)'}</option>
                <option value="on">Always on</option>
                <option value="off">Off</option>
              </select>
              <span className="help">Currently <span className={state.disclosureEffective ? 'ok' : 'strong'}>{state.disclosureEffective ? 'on' : 'off'}</span>. Each time it plays is logged below.</span>
            </div>

            <div className="field">
              <label htmlFor="pv-text">Notice wording (optional)</label>
              <textarea id="pv-text" className="input" value={text} onChange={e => setText(e.target.value)} maxLength={state.disclosureMaxChars} placeholder={state.defaultDisclosureText} rows={3} />
              <span className="help">Leave empty for the default shown. Spoken right after “Thanks for calling!”; keep it short. {text.length}/{state.disclosureMaxChars}</span>
            </div>

            <div className="field">
              <label htmlFor="pv-url">Privacy notice link</label>
              <input id="pv-url" className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://yourbusiness.in/privacy" />
              <span className="help">Sent in booking confirmation texts and the first WhatsApp reply while the notice is on.</span>
            </div>

            <div className="field">
              <label htmlFor="pv-days">Keep transcripts and messages for (days)</label>
              <input id="pv-days" className="input input-narrow" inputMode="numeric" value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} placeholder="Keep (no automatic deletion)" />
              <span className="help">Deleted daily once older than this. Empty = keep. Bookings are kept; notice records are kept at least {state.consentLogMinDays} days.</span>
              {shortRetention && (
                <span className="help warn">The DPDP Rules 2025 (rule 8(3)) ask for certain personal data and logs to be kept at least one year. Check with your adviser before choosing a shorter period.</span>
              )}
            </div>

            <div className="form-actions"><Button onClick={save} busy={busy}>Save</Button></div>
          </>
        )}
        <Status msg={msg} />
      </Card>

      {state && (
        <Card
          title="Caller data requests"
          description="When a caller asks what you hold about them, or asks you to delete it. Enter their number with country code. Check the request really comes from that person (e.g. call them back on that number) before acting."
        >
          <div className="form-row">
            <input className="input input-narrow" aria-label="Caller's phone number" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" />
            <Button variant="secondary" onClick={exportData} disabled={busy || !phone.trim()}>Download their data</Button>
            <Button variant="danger" onClick={erase} disabled={busy || !phone.trim()}>Erase…</Button>
          </div>
          <Status msg={reqMsg} />

          <h3>Recent notice records</h3>
          {notices.length === 0 ? <p className="muted small">None yet.</p> : (
            <Table head={['When', 'Channel', 'Call', 'Heard fully']}>
              {notices.map(n => (
                <tr key={n.id}>
                  <td data-label="When">{new Date(n.played_at * 1000).toLocaleString()}</td>
                  <td data-label="Channel">{n.channel}</td>
                  <td data-label="Call">{n.call_sid ? `…${n.call_sid.slice(-8)}` : '—'}{n.erased ? ' (caller erased)' : ''}</td>
                  <td data-label="Heard fully">{n.heard_fully === null ? '—' : n.heard_fully ? 'yes' : 'no (talked over / hung up)'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
