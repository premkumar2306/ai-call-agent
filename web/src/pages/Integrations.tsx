import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, Notice, Status } from '../components/ui';

// Operator → Integrations: every outside service, whether it's set up on this
// deployment (GET /admin/integrations: booleans only, never values), whether
// its live check passes (POST /admin/integrations/:id/check), and the
// production-readiness score with blockers first.

type IntStatus = 'not_configured' | 'unchecked' | 'ok' | 'fail';
interface CheckResult { ok: boolean | null; latencyMs: number; error?: string; note?: string; checkedAt: string }
interface Setting { name: string; required?: boolean; plain?: boolean; checkOnly?: boolean; purpose: string; set: boolean }
interface Integration {
  id: string; name: string; requirement: 'required' | 'carrier' | 'optional'; unlocks: string; getFrom: string; doc: string; cost: string;
  settings: Setting[]; missing: string[]; status: IntStatus; lastCheck: CheckResult | null;
}
interface Blocker { id: string; name: string; status: IntStatus; reason: string }
interface Data { integrations: Integration[]; readiness: { score: number; ready: boolean; blockers: Blocker[] } }

const REPO = 'https://github.com/premkumar2306/ai-call-agent/blob/main/';
const STATUS: Record<IntStatus, [string, 'success' | 'warning' | 'danger' | undefined]> = {
  not_configured: ['Not set up', undefined],
  unchecked: ['Set up — not checked', 'warning'],
  ok: ['Working', 'success'],
  fail: ['Failing', 'danger'],
};
const REQ: Record<Integration['requirement'], string> = { required: 'Required', carrier: 'Phone carrier', optional: 'Optional' };
const ORDER: Record<Integration['requirement'], number> = { required: 0, carrier: 1, optional: 2 };

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

function nextStep(i: Integration) {
  const link = i.getFrom.startsWith('http') ? <a href={i.getFrom} target="_blank" rel="noreferrer">{new URL(i.getFrom).hostname}</a> : i.getFrom;
  switch (i.status) {
    case 'not_configured': return <>Add {i.missing.map((m, k) => <span key={m}>{k ? ', ' : ''}<code>{m}</code></span>)}. Get {i.missing.length > 1 ? 'them' : 'it'} from {link}.</>;
    case 'unchecked': return i.lastCheck?.note ? <>{i.lastCheck.note}.</> : <>Run <span className="strong">Check now</span> to test the key.</>;
    case 'fail': return <>Check the key at {link}, update it with <code>wrangler secret put</code>, then check again.</>;
    default: return <>Nothing to do.</>;
  }
}

export default function Integrations({ base, adminKey }: { base: string; adminKey: string }) {
  const auth = { 'X-Admin-Key': adminKey };
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = () => api<Data>(base, '/admin/integrations', auth).then(setData).catch(e => setMsg({ text: e.message, ok: false }));
  useEffect(() => { load(); }, [base, adminKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkOne = async (id: string) => {
    try { await api(base, `/admin/integrations/${id}/check`, auth, { method: 'POST' }); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
  };
  const check = async (id: string) => { setBusy(id); setMsg(null); await checkOne(id); await load(); setBusy(null); };
  const checkAll = async () => {
    if (!data) return;
    setBusy('all'); setMsg(null);
    for (const i of data.integrations) if (i.status !== 'not_configured') await checkOne(i.id);
    await load(); setBusy(null);
  };

  if (!data) return msg ? <Notice tone="error">{msg.text}</Notice> : <p className="muted" role="status">Loading…</p>;
  const { readiness } = data;
  const list = [...data.integrations].sort((a, b) => ORDER[a.requirement] - ORDER[b.requirement]);
  const tone = readiness.ready ? 'usage-0' : readiness.score >= 50 ? 'usage-80' : 'usage-100';

  return (
    <>
      <Card
        title="Production readiness"
        description="Calls need email for sign-in, the AI, speech recognition, a voice and a phone carrier. Everything else is optional."
        actions={<Button variant="secondary" busy={busy === 'all'} disabled={!!busy} onClick={checkAll}>Check all</Button>}
      >
        <div className="readiness">
          <span className="figure">{readiness.score}%</span>
          <div className={`progress ${tone}`} role="img" aria-label={`${readiness.score}% ready`}><div style={{ width: `${readiness.score}%` }} /></div>
        </div>
        {readiness.ready
          ? <Notice tone="success">Ready for go-live: every required service is working.</Notice>
          : (
            <ul className="checklist">
              {readiness.blockers.map(b => (
                <li key={b.id}>
                  <span className="check warn" aria-hidden="true">!</span>
                  <div className="what"><a href={`#int-${b.id === 'carrier' ? 'twilio' : b.id}`}>{b.name}</a><span>{b.reason}</span></div>
                  <Badge tone={STATUS[b.status][1] ?? 'danger'}>{STATUS[b.status][0]}</Badge>
                </li>
              ))}
            </ul>
          )}
        <Status msg={msg} />
      </Card>

      <div className="integrations-grid">
        {list.map(i => {
          const [label, t] = STATUS[i.status];
          return (
            <section key={i.id} id={`int-${i.id}`} className={`card integration integration-${i.status}`} aria-labelledby={`int-${i.id}-h`}>
              <div className="row-between">
                <h2 id={`int-${i.id}-h`} className="integration-title">{i.name}</h2>
                <Badge tone={t}>{label}</Badge>
              </div>
              <p className="muted small">{REQ[i.requirement]} · {i.unlocks}</p>
              <p className="small"><span className="strong">Next: </span>{nextStep(i)}</p>
              {i.status === 'fail' && i.lastCheck?.error && <p className="small integration-error"><code>{i.lastCheck.error}</code></p>}
              <details className="more">
                <summary>Settings ({i.settings.filter(s => s.set).length}/{i.settings.length} set)</summary>
                <ul className="plain-list small">
                  {i.settings.map(s => (
                    <li key={s.name}>
                      <span aria-label={s.set ? 'set' : 'not set'}>{s.set ? '✓' : '✗'}</span> <code>{s.name}</code>
                      {s.required ? ' (required)' : ''}{s.plain ? ' · var' : ''} — <span className="muted">{s.purpose}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted small">Cost: {i.cost}</p>
              </details>
              <div className="row-between">
                <span className="muted small">
                  {i.lastCheck ? <>Checked {ago(i.lastCheck.checkedAt)}{i.lastCheck.ok !== null ? ` · ${i.lastCheck.latencyMs} ms` : ''}</> : 'Not checked yet'}
                  {' · '}<a href={REPO + i.doc} target="_blank" rel="noreferrer">Setup guide</a>
                </span>
                <Button size="sm" variant="secondary" busy={busy === i.id} disabled={!!busy || i.status === 'not_configured'} onClick={() => check(i.id)}>Check now</Button>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
