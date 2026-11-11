import { useEffect, useState } from 'react';
import { api } from '../auth';
import { practitionerWords } from '../business';
import { Button, Card, Notice } from '../components/ui';

// Today at a glance, and — for owners — a setup checklist until the business
// is ready. Built from the same read-only endpoints the other pages use.

interface Props {
  sector: string;
  name: string;
  base: string;
  auth: Record<string, string>;
  isOwner: boolean;
  go: (route: string) => void;
}

interface Step { key: string; title: string; detail: string; done: boolean; route: string }

const toMs = (v: number | string) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : new Date(v).getTime());
const isToday = (v: number | string) => new Date(toMs(v)).toDateString() === new Date().toDateString();
const settle = <T,>(p: Promise<T>) => p.then(v => v, () => null);

export default function Home({ sector, name, base, auth, isOwner, go }: Props) {
  const [today, setToday] = useState<{ calls: number; chats: number; bookings: number; unread: number } | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setToday(null); setSteps(null); setError('');
    const key = encodeURIComponent(sector);
    Promise.all([
      api<{ callSid: string | null; createdAt: number | string }[]>(base, `/admin/transcripts/${key}`, auth),
      api<{ status: string; createdAt: number | string }[]>(base, `/admin/bookings/${key}`, auth),
      api<{ status: string }[]>(base, `/admin/messages/${key}`, auth),
    ]).then(([ts, bs, ms]) => {
      if (!live) return;
      const todays = ts.filter(t => isToday(t.createdAt));
      setToday({
        calls: todays.filter(t => !t.callSid?.startsWith('wa:')).length,
        chats: todays.filter(t => t.callSid?.startsWith('wa:')).length,
        bookings: bs.filter(b => b.status !== 'CANCELLED' && isToday(b.createdAt)).length,
        unread: ms.filter(m => m.status !== 'DONE').length,
      });
    }).catch(e => live && setError(e.message));

    if (isOwner) {
      Promise.all([
        settle(api<any>(base, `/admin/sectors/${key}`, auth)),
        settle(api<{ isActive: boolean }[]>(base, `/admin/products/${key}`, auth)),
        settle(api<{ isActive: boolean }[]>(base, `/admin/resources/${key}`, auth)),
        settle(api<{ status: string }[]>(base, `/account/businesses/${key}/number-request`, auth)),
        settle(api<{ privacyNoticeUrl: string | null }>(base, `/admin/privacy/${key}/settings`, auth)),
        settle(api<{ state: string }>(base, `/billing/${key}`, auth)),
      ]).then(([biz, products, people, numbers, privacy, billing]) => {
        if (!live) return;
        const words = practitionerWords(biz?.vertical, biz?.kind);
        const list: Step[] = [
          { key: 'details', title: 'Add your address and opening hours', detail: 'So the assistant can tell callers where and when.', done: !!biz?.address && Object.keys(biz?.hours ?? {}).length > 0, route: 'settings/business' },
          { key: 'services', title: 'Add your services and prices', detail: 'What callers can book, and what it costs.', done: !!products?.some(p => p.isActive), route: 'services' },
          ...(words ? [{ key: 'team', title: `Add your ${words.many.toLowerCase()}`, detail: `So callers can book a ${words.one.toLowerCase()} by name.`, done: !!people?.some(p => p.isActive), route: 'team' }] : []),
          { key: 'try', title: 'Try your assistant', detail: 'Make a test call in the app and hear how it answers.', done: false, route: 'try' },
          { key: 'number', title: 'Request a phone number', detail: 'The Avery team connects a number for callers to dial.', done: !!numbers?.length, route: 'settings/phone' },
          { key: 'privacy', title: 'Add your privacy notice link', detail: 'Sent to callers in booking texts and WhatsApp replies.', done: !!privacy?.privacyNoticeUrl, route: 'settings/privacy' },
          // Billing "off" means no plan is offered yet, so there is nothing to choose.
          ...(billing && billing.state !== 'off' ? [{ key: 'billing', title: 'Choose a plan', detail: 'Subscribe before your free trial ends.', done: billing.state === 'active', route: 'settings/billing' }] : []),
        ];
        setSteps(list);
      });
    }
    return () => { live = false; };
  }, [sector, base, auth, isOwner]);

  // "Try" is a suggestion, not a requirement: it isn't counted.
  const required = steps?.filter(s => s.key !== 'try') ?? [];
  const doneCount = required.filter(s => s.done).length;
  const ready = steps !== null && doneCount === required.length;
  const next = steps?.find(s => !s.done && s.key !== 'try');

  const stat = (num: number | undefined, label: string, route: string) => (
    <button type="button" className="stat" onClick={() => go(route)}>
      <div className="num">{num ?? '–'}</div>
      <div className="lbl">{label}</div>
    </button>
  );

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{name}</h1>
          <p>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        {next && <div className="actions"><Button onClick={() => go(next.route)}>Next: {next.title.toLowerCase()}</Button></div>}
      </header>

      {error && <Notice tone="error">{error}</Notice>}
      <section aria-label="Today">
        <h2 className="sr-only">Today</h2>
        <div className="stats">
          {stat(today?.calls, 'Calls today', 'calls')}
          {stat(today?.bookings, 'New appointments today', 'appointments')}
          {stat(today?.unread, 'Messages to call back', 'calls')}
          {stat(today?.chats, 'WhatsApp chats today', 'calls')}
        </div>
      </section>

      {isOwner && steps && !ready && (
        <Card title="Get your assistant ready" description={`${doneCount} of ${required.length} done. Finish these and your assistant can take real calls.`}>
          <div className="progress" aria-hidden="true" style={{ marginBottom: 8 }}><div style={{ width: `${(doneCount / required.length) * 100}%` }} /></div>
          <ul className="checklist">
            {steps.map(s => (
              <li key={s.key}>
                <span className={`check${s.done ? ' done' : ''}`} aria-hidden="true">✓</span>
                <div className="what">
                  {s.title}<span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                  <span>{s.detail}</span>
                </div>
                <Button variant={s.done ? 'ghost' : 'secondary'} size="sm" onClick={() => go(s.route)}>{s.done ? 'Review' : s.key === 'try' ? 'Try it' : 'Set up'}</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {isOwner && ready && <Notice tone="success">Your assistant is set up. You can change anything in Settings.</Notice>}

      <Card title="Quick links">
        <div className="row">
          <Button variant="secondary" onClick={() => go('calls')}>See calls and messages</Button>
          <Button variant="secondary" onClick={() => go('appointments')}>See appointments</Button>
          <Button variant="secondary" onClick={() => go('try')}>Try your assistant</Button>
        </div>
      </Card>
    </>
  );
}
