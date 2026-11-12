import { useEffect, useMemo, useState } from 'react';
import { api } from '../auth';
import { practitionerWords } from '../business';
import type { SectorLocale } from '../locale';
import { Button, Card, EmptyState, Notice } from '../components/ui';
import { Feed, TranscriptDialog } from '../components/Activity';
import { buildActivity, isToday, loadBusinessData, type Activity, type BusinessData } from '../lib/activity';

// Home: recent calls and chats first, today's numbers, then (owners only) the
// setup checklist, folded into one line once something is done.

interface Props {
  sector: string;
  name: string;
  locale?: SectorLocale;
  base: string;
  auth: Record<string, string>;
  isOwner: boolean;
  operator?: boolean;
  go: (route: string) => void;
}

interface Step { key: string; title: string; detail: string; done: boolean; route: string; optional?: boolean }
const settle = <T,>(p: Promise<T>) => p.then(v => v, () => null);

export default function Home({ sector, name, locale, base, auth, isOwner, operator = false, go }: Props) {
  const [data, setData] = useState<BusinessData | null>(null);
  const [error, setError] = useState('');
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [open, setOpen] = useState<Activity | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null); setSteps(null); setError('');
    loadBusinessData(base, auth, sector).then(d => live && setData(d)).catch((e: Error) => live && setError(e.message));

    if (isOwner) {
      const key = encodeURIComponent(sector);
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
        setSteps([
          { key: 'details', title: 'Add your address and opening hours', detail: 'So the assistant can tell callers where and when.', done: !!biz?.address && Object.keys(biz?.hours ?? {}).length > 0, route: 'settings/business' },
          { key: 'services', title: 'Add your services and prices', detail: 'What callers can book, and what it costs.', done: !!products?.some(p => p.isActive), route: 'services' },
          ...(words ? [{ key: 'team', title: `Add your ${words.many.toLowerCase()}`, detail: `So callers can book a ${words.one.toLowerCase()} by name.`, done: !!people?.some(p => p.isActive), route: 'team' }] : []),
          { key: 'number', title: 'Request a phone number', detail: 'The Avery team connects a number for callers to dial.', done: !!numbers?.length, route: 'settings/phone' },
          { key: 'privacy', title: 'Add your privacy notice link', detail: 'Sent to callers in booking texts and WhatsApp replies.', done: !!privacy?.privacyNoticeUrl, route: 'settings/privacy' },
          // Billing "off" means no plan is offered yet, so there is nothing to choose.
          ...(billing && billing.state !== 'off' ? [{ key: 'billing', title: 'Choose a plan', detail: 'Subscribe before your free trial ends.', done: billing.state === 'active', route: 'settings/billing' }] : []),
          { key: 'try', title: 'Try your assistant', detail: 'Make a test call in the app and hear how it answers.', done: false, route: 'try', optional: true },
        ]);
      });
    }
    return () => { live = false; };
  }, [sector, base, auth, isOwner]);

  const activity = useMemo(() => (data ? buildActivity(data.transcripts, data.bookings, data.messages, locale?.locale) : []), [data, locale?.locale]);
  const todays = activity.filter(a => isToday(a.t.createdAt));
  const stats = data && {
    calls: todays.filter(a => a.channel === 'call').length,
    chats: todays.filter(a => a.channel === 'whatsapp').length,
    bookings: data.bookings.filter(b => b.status !== 'CANCELLED' && isToday(b.createdAt)).length,
    unread: data.messages.filter(m => m.status !== 'DONE').length,
  };

  const required = steps?.filter(s => !s.optional) ?? [];
  const doneCount = required.filter(s => s.done).length;
  const allDone = steps !== null && doneCount === required.length;
  const next = steps?.find(s => !s.done && !s.optional);
  const showFull = expanded || doneCount === 0;

  const stat = (num: number | undefined, label: string, route: string) => (
    <button type="button" className="stat" onClick={() => go(route)}>
      <span className="num">{num ?? '–'}</span>
      <span className="lbl">{label}</span>
    </button>
  );

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{name}</h1>
          <p>{new Date().toLocaleDateString(locale?.locale || undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </header>

      {error && <Notice tone="error">{error}</Notice>}

      <Card
        className="card-flush"
        title="Recent calls & chats"
        actions={<Button variant="ghost" size="sm" onClick={() => go('calls')}>See all</Button>}
      >
        {!data && !error && <p className="muted pad" role="status">Loading…</p>}
        {data && activity.length === 0 && (
          <EmptyState title="No calls yet" action={<Button variant="secondary" onClick={() => go('try')}>Try your assistant</Button>}>
            Calls and WhatsApp chats will show up here as they happen.
          </EmptyState>
        )}
        {activity.length > 0 && <Feed items={activity.slice(0, 10)} onOpen={setOpen} />}
      </Card>

      <section aria-label="Today">
        <h2 className="sr-only">Today</h2>
        <div className="stats">
          {stat(stats?.calls, 'calls today', 'calls')}
          {stat(stats?.bookings, 'booked today', 'calendar')}
          {stat(stats?.unread, 'to call back', 'calls')}
          {stat(stats?.chats, 'WhatsApp today', 'calls')}
        </div>
      </section>

      {isOwner && steps && !allDone && (showFull ? (
        <Card
          title="Get your assistant ready"
          description={`${doneCount} of ${required.length} done. Finish these and your assistant can take real calls.`}
          actions={doneCount > 0 && <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Hide</Button>}
        >
          <div className="progress" aria-hidden="true"><div style={{ width: `${(doneCount / required.length) * 100}%` }} /></div>
          <ul className="checklist">
            {steps.map(s => (
              <li key={s.key}>
                <span className={`check${s.done ? ' done' : ''}`} aria-hidden="true">✓</span>
                <div className="what">
                  {s.title}{s.optional && <span className="subtle"> (optional)</span>}
                  <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                  <span>{s.detail}</span>
                </div>
                <Button variant={s.done ? 'ghost' : 'secondary'} size="sm" onClick={() => go(s.route)}>{s.done ? 'Review' : s.optional ? 'Try it' : 'Set up'}</Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <div className="card setup-line">
          <span className="strong">Setup: {doneCount} of {required.length} done</span>
          <div className="progress" aria-hidden="true"><div style={{ width: `${(doneCount / required.length) * 100}%` }} /></div>
          <span className="spacer" />
          {next && <Button size="sm" onClick={() => go(next.route)}>Continue: {next.title.toLowerCase()}</Button>}
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>Show all</Button>
        </div>
      ))}

      {open && <TranscriptDialog a={open} showLatency={operator} onClose={() => setOpen(null)} />}
    </>
  );
}
