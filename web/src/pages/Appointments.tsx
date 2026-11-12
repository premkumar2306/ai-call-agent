import { useEffect, useMemo, useState } from 'react';
import { api } from '../auth';
import { formatMoney, formatPhone, type SectorLocale } from '../locale';
import { Badge, Button, Card, Dialog, EmptyState, Notice, ViewToggle } from '../components/ui';
import { bookingDetails, formatClock, formatSlot, slotParts, toMs, type BookingRow } from '../lib/activity';
import Calendar from './Calendar';

// The Calendar page: the Google Calendar connection, then this week's
// bookings as a week grid (desktop default) or a list (phone default).

interface Props {
  sector: string;
  locale?: SectorLocale;
  base: string;
  auth: Record<string, string>;
  canEdit: boolean;
  operator: boolean;
  oauthResult?: { ok: boolean; reason?: string } | null;
}

type View = 'week' | 'list';
const DAY_MS = 86_400_000;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
const STATUS: Record<string, { label: string; tone?: 'success' | 'warning' | 'danger' }> = {
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  PENDING: { label: 'Pending', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

export default function Appointments({ sector, locale, base, auth, canEdit, operator, oauthResult }: Props) {
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(() => (window.matchMedia?.('(max-width: 860px)').matches ? 'list' : 'week'));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [open, setOpen] = useState<BookingRow | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null); setError('');
    api<BookingRow[]>(base, `/admin/bookings/${encodeURIComponent(sector)}`, auth)
      .then(r => live && setRows(r)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [base, auth, sector]);

  const today = ymd(new Date());
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymd(new Date(weekStart.getTime() + i * DAY_MS + 3_600_000))), [weekStart]);
  const visible = (rows ?? []).filter(b => b.scheduledAt && (showCancelled || b.status !== 'CANCELLED'));
  const byDay = (d: string) => visible.filter(b => slotParts(b.scheduledAt!).date === d).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  const upcoming = visible.filter(b => slotParts(b.scheduledAt!).date >= today).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  const unscheduled = (rows ?? []).filter(b => !b.scheduledAt && b.status !== 'CANCELLED');
  const loc = locale?.locale;

  const time = (b: BookingRow) => { const p = slotParts(b.scheduledAt!); return formatClock(p.h, p.m, loc); };
  const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00`).toLocaleDateString(loc || undefined, opts);
  const weekTitle = `${dayLabel(days[0], { day: 'numeric', month: 'short' })} – ${dayLabel(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const listDays = [...new Set(upcoming.map(b => slotParts(b.scheduledAt!).date))];

  return (
    <>
      <Calendar sector={sector} base={base} auth={auth} oauthResult={oauthResult} canEdit={canEdit} operator={operator} />

      <Card
        title="Appointments"
        description="Booked by the assistant on calls and WhatsApp. Click one for the details."
        actions={<ViewToggle label="View" value={view} onChange={setView} options={[{ key: 'week', label: 'Week' }, { key: 'list', label: 'List' }]} />}
      >
        {error && <Notice tone="error">{error}</Notice>}
        {!rows && !error && <p className="muted" role="status">Loading…</p>}

        {rows && view === 'week' && (
          <>
            <div className="row-between">
              <div className="row">
                <Button variant="secondary" size="sm" aria-label="Previous week" onClick={() => setWeekStart(w => new Date(w.getTime() - 7 * DAY_MS))}>‹</Button>
                <Button variant="secondary" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
                <Button variant="secondary" size="sm" aria-label="Next week" onClick={() => setWeekStart(w => new Date(w.getTime() + 7 * DAY_MS))}>›</Button>
                <span className="strong">{weekTitle}</span>
              </div>
              <label className="check-row small"><input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} /> Show cancelled</label>
            </div>
            <div className="week">
              {days.map(d => (
                <div key={d} className={`week-day${d === today ? ' today' : ''}`} aria-current={d === today ? 'date' : undefined}>
                  <div className="week-head">{dayLabel(d, { weekday: 'short' })}<b>{dayLabel(d, { day: 'numeric' })}</b></div>
                  <div className="week-events">
                    {byDay(d).map(b => (
                      <button key={b.id} type="button" className={`event${b.status === 'CANCELLED' ? ' cancelled' : ''}`} onClick={() => setOpen(b)}>
                        <span className="t">{time(b)}</span>
                        <span>{b.customerName ?? 'Caller'}</span>
                        <span>{b.productName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {rows && view === 'list' && (upcoming.length === 0 ? (
          <EmptyState title="No upcoming appointments">When a caller books, it shows up here.</EmptyState>
        ) : (
          <div className="agenda">
            {listDays.map(d => (
              <section key={d} className={`agenda-day${d === today ? ' today' : ''}`}>
                <h3>{d === today ? 'Today · ' : ''}{dayLabel(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                {upcoming.filter(b => slotParts(b.scheduledAt!).date === d).map(b => (
                  <button key={b.id} type="button" className="agenda-item" onClick={() => setOpen(b)}>
                    <span className="t">{time(b)}</span>
                    <span className="main">{b.customerName ?? 'Caller'}<span>{b.productName}{b.resourceName ? ` · ${b.resourceName}` : ''}</span></span>
                    {b.status !== 'CONFIRMED' && <Badge tone={STATUS[b.status]?.tone}>{STATUS[b.status]?.label ?? b.status}</Badge>}
                  </button>
                ))}
              </section>
            ))}
          </div>
        ))}

        {rows && unscheduled.length > 0 && <p className="muted small">{unscheduled.length} order{unscheduled.length > 1 ? 's' : ''} without a time are not shown.</p>}
      </Card>

      {open && (
        <Dialog title={open.customerName ?? 'Caller'} subtitle={formatSlot(open.scheduledAt, loc)} onClose={() => setOpen(null)}>
          <dl className="kv">
            <dt>Service</dt><dd>{open.productName}</dd>
            {open.resourceName && <><dt>With</dt><dd>{open.resourceName}</dd></>}
            <dt>Status</dt><dd><Badge tone={STATUS[open.status]?.tone}>{STATUS[open.status]?.label ?? open.status}</Badge></dd>
            {open.callbackPhone && <><dt>Phone</dt><dd><a href={`tel:${open.callbackPhone}`}>{formatPhone(open.callbackPhone)}</a></dd></>}
            {open.priceCents != null && open.priceCents > 0 && <><dt>Price</dt><dd>{formatMoney(open.priceCents, locale)}</dd></>}
            {bookingDetails({ ...open, resourceName: null }) && <><dt>Details</dt><dd>{bookingDetails({ ...open, resourceName: null })}</dd></>}
            {open.notes && <><dt>Notes</dt><dd>{open.notes}</dd></>}
            {open.calendarSync && <><dt>Google Calendar</dt><dd>{open.calendarSync === 'synced' ? 'Added' : 'Not added (sync failed)'}</dd></>}
            <dt>Booked</dt><dd>{new Date(toMs(open.createdAt)).toLocaleString(loc || undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          </dl>
        </Dialog>
      )}
    </>
  );
}
