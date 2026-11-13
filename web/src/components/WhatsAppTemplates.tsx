import { useEffect, useState } from 'react';
import { api } from '../auth';
import { Badge, Button, Card, Notice, Status } from './ui';
import { EVENT_LABEL, templateTone, type TemplateSummary } from './WhatsAppHealth';

// Operator → WhatsApp → Message templates: create Avery's utility templates
// on Meta (English, Hindi, Hinglish), see their approval status, and choose
// which template each event uses. With no approved template for an event,
// reminders fall back to SMS and the other messages are skipped (logged).

interface TemplateRow { name: string; language: string; variant: string | null; purpose: string | null; category: string | null; status: string; body: string | null; rejectedReason: string | null }
interface Def { event: string; family: string; example: string[]; body: Record<string, string> }
interface Data { wabaConfigured: boolean; templates: TemplateRow[]; events: TemplateSummary[]; defaults: Def[] }

const LANG: Record<string, string> = { en: 'English', hi: 'Hindi', 'hi-en': 'Hinglish' };
const FALLBACK: Record<string, string> = {
  confirmation: 'Without one: SMS, as today.',
  reminder: 'Without one: SMS (if set up), else skipped.',
  cancellation: 'Without one: SMS, as today.',
  missed_call: 'Without one: skipped (logged).',
};

export default function WhatsAppTemplates({ base, adminKey }: { base: string; adminKey: string }) {
  const auth = { 'X-Admin-Key': adminKey };
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [custom, setCustom] = useState({ name: '', variant: 'en', body: '', example: '', event: '' });

  const load = () => api<Data>(base, '/admin/whatsapp/templates', auth).then(setData).catch(e => setMsg({ text: e.message, ok: false }));
  useEffect(() => { load(); }, [base, adminKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async <T,>(key: string, fn: () => Promise<T>, ok: string | ((r: T) => string)) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ text: typeof ok === 'string' ? ok : ok(r), ok: true }); await load(); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(null); }
  };

  if (!data) return <Card title="Message templates">{msg ? <Status msg={msg} /> : <p className="muted" role="status">Loading…</p>}</Card>;
  const families = [...new Set(data.templates.map(t => t.name.replace(/_hinglish$/, '')))];

  return (
    <Card
      title="Message templates"
      description="Meta only lets a business start a conversation (a reminder, a follow-up, a confirmation outside the 24-hour window) with an approved template. Avery's are utility templates in English, Hindi and Hinglish."
      actions={<Button variant="secondary" size="sm" busy={busy === 'sync'} disabled={!data.wabaConfigured || !!busy}
        onClick={() => run('sync', () => api(base, '/admin/whatsapp/templates/sync', auth, { method: 'POST' }), 'Statuses updated from Meta.')}>Sync from Meta</Button>}
    >
      {!data.wabaConfigured && <Notice tone="warning">Set <code>WA_BUSINESS_ACCOUNT_ID</code> (WhatsApp Manager → Account tools → the WhatsApp Business Account id) to create and sync templates.</Notice>}
      <div className="wa-events">
        {data.events.map(e => {
          const def = data.defaults.find(d => d.event === e.event);
          const options = [...new Set([def?.family, ...families].filter(Boolean) as string[])];
          return (
            <section key={e.event} className="wa-event" aria-labelledby={`wa-ev-${e.event}`}>
              <div className="row-between">
                <h3 id={`wa-ev-${e.event}`}>{EVENT_LABEL[e.event] ?? e.event}</h3>
                {e.family ? (e.ready ? <Badge tone="success">Sending on WhatsApp</Badge> : <Badge tone="warning">Waiting for approval</Badge>) : <Badge>Off</Badge>}
              </div>
              <div className="form-row">
                <div className="field grow">
                  <label htmlFor={`wa-choice-${e.event}`}>Template</label>
                  <select id={`wa-choice-${e.event}`} className="input" value={e.family ?? ''} disabled={!!busy}
                    onChange={ev => run(`choice-${e.event}`, () => api(base, '/admin/whatsapp/templates/choice', auth, { method: 'PUT', body: { event: e.event, family: ev.target.value || null } }),
                      ev.target.value ? `${EVENT_LABEL[e.event]} now uses ${ev.target.value}.` : `${EVENT_LABEL[e.event]}: no WhatsApp template.`)}>
                    <option value="">None ({FALLBACK[e.event]?.replace('Without one: ', '').replace(/\.$/, '')})</option>
                    {options.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                {def && (
                  <Button variant="secondary" busy={busy === `create-${e.event}`} disabled={!data.wabaConfigured || !!busy}
                    onClick={() => run(`create-${e.event}`, () => api(base, '/admin/whatsapp/templates', auth, { body: { event: e.event } }), 'Sent to Meta for review. Approval usually takes minutes, sometimes a day.')}>
                    Create Avery's template
                  </Button>
                )}
              </div>
              <div className="chips" aria-label="Languages">
                {(e.variants.length ? e.variants : (def ? ['en', 'hi', 'hi-en'].map(v => {
                  const name = v === 'hi-en' ? `${def.family}_hinglish` : def.family;
                  const lang = v === 'hi-en' ? 'en' : v;
                  return { variant: v, name, language: lang, status: data.templates.find(t => t.name === name && t.language === lang)?.status ?? null };
                }) : [])).map(v => {
                  const row = data.templates.find(t => t.name === v.name && t.language === v.language);
                  return (
                    <span key={v.variant} title={row?.rejectedReason ? `Rejected: ${row.rejectedReason}` : v.name}>
                      <Badge tone={templateTone(v.status)}>{LANG[v.variant] ?? v.variant}: {v.status ? v.status.toLowerCase() : 'not created'}</Badge>
                    </span>
                  );
                })}
              </div>
              {def && (
                <details className="more">
                  <summary>Wording</summary>
                  <ul className="plain-list small">
                    {Object.entries(def.body).map(([v, b]) => <li key={v}><span className="strong">{LANG[v]}:</span> {b}</li>)}
                  </ul>
                  <p className="muted small">{'{{1}}'} business, {'{{2}}'} service, {'{{3}}'} date and time. {FALLBACK[e.event]}</p>
                </details>
              )}
            </section>
          );
        })}
      </div>

      <details className="more">
        <summary>Create a custom template</summary>
        <form className="form-grid" onSubmit={ev => {
          ev.preventDefault();
          run('custom', () => api(base, '/admin/whatsapp/templates', auth, {
            body: { name: custom.name, variant: custom.variant, body: custom.body, example: custom.example.split('|').map(s => s.trim()), event: custom.event || undefined },
          }), 'Sent to Meta for review.');
        }}>
          <div className="field">
            <label htmlFor="wa-c-name">Name</label>
            <input id="wa-c-name" className="input" placeholder="clinic_reminder" value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
            <span className="help">Hinglish adds _hinglish to the name.</span>
          </div>
          <div className="field">
            <label htmlFor="wa-c-lang">Language</label>
            <select id="wa-c-lang" className="input" value={custom.variant} onChange={e => setCustom({ ...custom, variant: e.target.value })}>
              {Object.entries(LANG).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="wa-c-body">Body</label>
            <textarea id="wa-c-body" className="input" rows={3} value={custom.body} onChange={e => setCustom({ ...custom, body: e.target.value })}
              placeholder="Reminder from {{1}}: your {{2}} is {{3}}. Reply STOP to opt out." />
            <span className="help">Not starting or ending with a parameter; must say how to opt out (STOP).</span>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="wa-c-ex">Examples, separated by |</label>
            <input id="wa-c-ex" className="input" placeholder="Sharma Clinic | Check-up | tomorrow, 10:30 am" value={custom.example} onChange={e => setCustom({ ...custom, example: e.target.value })} />
          </div>
          <div className="form-actions"><Button type="submit" busy={busy === 'custom'} disabled={!data.wabaConfigured || !custom.name || !custom.body || !!busy}>Send for review</Button></div>
        </form>
      </details>

      <div className="row-between">
        <span className="muted small">Reminders run every hour for businesses that turned them on (owner Settings → WhatsApp).</span>
        <Button variant="secondary" size="sm" busy={busy === 'remind'} disabled={!!busy}
          onClick={() => run('remind', () => api<{ outcome: string }[]>(base, '/admin/whatsapp/reminders/run', auth, { method: 'POST', body: {} }),
            r => `${r.length} reminder(s) handled${r.length ? `: ${r.map(x => x.outcome).join(', ')}` : ''}.`)}>Send due reminders now</Button>
      </div>
      <Status msg={msg} />
    </Card>
  );
}
