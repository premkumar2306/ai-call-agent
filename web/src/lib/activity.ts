// Calls, WhatsApp chats, bookings and messages for one business, joined into
// an activity feed: who, when, channel, what happened, one-line summary.
// Read-only: the same /admin/transcripts|bookings|messages endpoints as before.
import { api } from '../auth';
import { formatPhone } from '../locale';

export interface TurnMetric {
  n: number; at: number; text: string; queued: number; laps: [string, number][];
  firstAudio?: number; fillers: number; outcome: 'done' | 'interrupted' | 'dropped';
}
export interface TranscriptRow {
  id: string; callSid: string | null; customerIdHashed: string; businessType: string;
  turns: Array<{ role: string; content: string }>; metrics?: TurnMetric[] | null;
  createdAt: number | string; updatedAt?: number | string;
}
export interface BookingRow {
  id: string; businessType: string; customerIdHashed?: string; productName: string; status: string;
  scheduledAt: string | null; endsAt?: string | null; customerName: string | null; vehicle: string | null;
  resourceName?: string | null; details?: Record<string, string> | null; callbackPhone: string | null;
  notes: string | null; priceCents?: number; calendarSync?: string | null; createdAt: number | string;
}
export interface MessageRow {
  id: string; businessType: string; callSid?: string | null; customerIdHashed?: string | null;
  callerName: string | null; callbackPhone: string | null; message: string; status: string; createdAt: number | string;
}

export type Channel = 'call' | 'whatsapp' | 'web';
export type Outcome = 'booked' | 'message' | 'transferred' | 'info';
export const OUTCOME: Record<Outcome, { label: string; tone: 'success' | 'warning' | 'info' | undefined }> = {
  booked: { label: 'Booked', tone: 'success' },
  message: { label: 'Message taken', tone: 'warning' },
  transferred: { label: 'Transferred', tone: 'info' },
  info: { label: 'Info only', tone: undefined },
};

export interface Activity {
  t: TranscriptRow; channel: Channel; outcome: Outcome; who: string; summary: string;
  booking?: BookingRow; message?: MessageRow;
}

/** Seconds (D1 timestamps) or an ISO string → ms. */
export const toMs = (v: number | string | undefined | null): number =>
  v == null ? 0 : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : new Date(v).getTime();

export const isToday = (v: number | string) => new Date(toMs(v)).toDateString() === new Date().toDateString();

export function channelOf(callSid: string | null): Channel {
  if (!callSid) return 'web';
  if (callSid.startsWith('wa:')) return 'whatsapp';
  if (callSid.startsWith('web-')) return 'web';
  return 'call';
}
export const CHANNEL_ICON: Record<Channel, string> = { call: '📞', whatsapp: '💬', web: '🖥' };
export const CHANNEL_NAME: Record<Channel, string> = { call: 'Phone call', whatsapp: 'WhatsApp', web: 'Test in the app' };

export function formatWhen(ts: number | string): string {
  const d = new Date(toMs(ts));
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (isToday(ts)) return `Today ${time}`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(start: number | string, end?: number | string): string | null {
  if (!end) return null;
  const secs = Math.round((toMs(end) - toMs(start)) / 1000);
  if (secs < 1) return null;
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// Booking times are the business's wall clock ("2026-11-12T10:30:00").
export function slotParts(iso: string): { date: string; h: number; m: number } {
  const [date, t = '00:00'] = iso.split('T');
  const [h, m] = t.split(':').map(Number);
  return { date, h, m };
}
export function formatClock(h: number, m: number, locale?: string): string {
  try {
    return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale || undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  } catch { return `${h}:${String(m).padStart(2, '0')}`; }
}
export function formatSlot(iso: string | null, locale?: string): string {
  if (!iso) return '—';
  const { date, h, m } = slotParts(iso);
  const day = new Date(`${date}T12:00:00`).toLocaleDateString(locale || undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day}, ${formatClock(h, m, locale)}`;
}

export function bookingDetails(b: BookingRow): string {
  const parts = [
    b.resourceName ? `with ${b.resourceName}` : '',
    b.vehicle ?? '',
    ...Object.entries(b.details ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`),
  ].filter(Boolean);
  return parts.join(' · ');
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Test calls made in the app before each session kept one row saved a new row
 * on every turn, each a longer copy of the last. Keep only the longest copy.
 */
export function dropPartialCopies(ts: TranscriptRow[]): TranscriptRow[] {
  const isPrefix = (short: TranscriptRow, long: TranscriptRow) =>
    short.turns.length < long.turns.length && short.turns.every((x, i) => long.turns[i]?.role === x.role && long.turns[i]?.content === x.content);
  return ts.filter(t => t.callSid || !ts.some(u => u !== t && !u.callSid && u.customerIdHashed === t.customerIdHashed && isPrefix(t, u)));
}

/** Work out what happened on each conversation from the bookings and messages it left behind. */
export function buildActivity(ts: TranscriptRow[], bookings: BookingRow[], messages: MessageRow[], locale?: string): Activity[] {
  return dropPartialCopies(ts)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .map(t => {
      const start = toMs(t.createdAt) - 60_000;
      const end = toMs(t.updatedAt ?? t.createdAt) + 120_000;
      const inWindow = (v: number | string) => { const x = toMs(v); return x >= start && x <= end; };
      const sameCaller = (h?: string | null) => !!h && h === t.customerIdHashed;
      const booking = bookings.find(b => b.status !== 'CANCELLED' && sameCaller(b.customerIdHashed) && inWindow(b.createdAt));
      const message = messages.find(m => (t.callSid && m.callSid === t.callSid) || (sameCaller(m.customerIdHashed) && inWindow(m.createdAt)));
      const transferred = t.turns.some(x => x.role === 'assistant' && /connecting you to/i.test(x.content));
      const outcome: Outcome = booking ? 'booked' : message ? 'message' : transferred ? 'transferred' : 'info';
      const phone = booking?.callbackPhone ?? message?.callbackPhone;
      const who = booking?.customerName || message?.callerName || (phone ? formatPhone(phone) : `Caller …${t.customerIdHashed.slice(-4)}`);
      const firstAsk = t.turns.find(x => x.role === 'user')?.content ?? '';
      const summary = booking ? `Booked ${booking.productName}${booking.scheduledAt ? ` for ${formatSlot(booking.scheduledAt, locale)}` : ''}`
        : message ? `Message: ${message.message}`
        : transferred ? `Asked for a person: “${clip(firstAsk, 60)}”`
        : firstAsk ? `“${clip(firstAsk)}”` : 'No words captured';
      return { t, channel: channelOf(t.callSid), outcome, who, summary, booking, message };
    });
}

export interface BusinessData { transcripts: TranscriptRow[]; bookings: BookingRow[]; messages: MessageRow[] }

export async function loadBusinessData(base: string, auth: Record<string, string>, key: string): Promise<BusinessData> {
  const k = encodeURIComponent(key);
  const [transcripts, bookings, messages] = await Promise.all([
    api<TranscriptRow[]>(base, `/admin/transcripts/${k}`, auth),
    api<BookingRow[]>(base, `/admin/bookings/${k}`, auth).catch(() => [] as BookingRow[]),
    api<MessageRow[]>(base, `/admin/messages/${k}`, auth).catch(() => [] as MessageRow[]),
  ]);
  return { transcripts, bookings, messages };
}
