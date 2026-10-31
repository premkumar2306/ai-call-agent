import { HTTP_TIMEOUT_MS } from '../config';
import type { Env, Order, SectorMeta } from '../types';
import { formatSlotLabel } from './tool-router.service';

// Tells people what the agent did: the business (email to the sector's
// notify_email) and the caller (text to their callback number). Each channel
// is optional and switches on when its credentials exist:
//   email — RESEND_API_KEY (+ EMAIL_FROM), and sectors.notify_email set
//   text  — TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM
// Failures are logged, never thrown: a booking is already made by the time
// anyone is told about it.

export type BookingEvent = 'booked' | 'rescheduled' | 'cancelled';

async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY === 'CHANGE_ME') {
    console.log(`[notify] RESEND_API_KEY not set; skipping email "${subject}"`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM ?? 'Mogi <mogi@mogi.ai>', to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendSms(env: Env, to: string, body: string): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID;
  if (!sid || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_SMS_FROM) {
    console.log('[notify] Twilio SMS not configured; skipping confirmation text');
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_SMS_FROM, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio SMS ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const logFail = (what: string) => (e: any) => console.error(`[notify] ${what} failed`, e?.message || e);

export function bookingSummary(order: Order): string {
  const when = order.scheduledAt ? formatSlotLabel(order.scheduledAt) : 'no time set';
  return [
    `${order.productName} — ${when}`,
    `Customer: ${order.customerName ?? 'not given'}`,
    order.vehicle ? `Vehicle: ${order.vehicle}` : '',
    `Callback: ${order.callbackPhone ?? 'not given'}`,
    order.notes ? `Notes: ${order.notes}` : '',
    `Booking ref: ${order.id.slice(0, 8)}`,
  ].filter(Boolean).join('\n');
}

export async function notifyBooking(env: Env, meta: SectorMeta | null | undefined, order: Order, event: BookingEvent): Promise<void> {
  const name = meta?.name ?? order.businessType;
  const verb = event === 'booked' ? 'New booking' : event === 'rescheduled' ? 'Booking moved' : 'Booking cancelled';
  const jobs: Promise<void>[] = [];
  if (meta?.notifyEmail) {
    jobs.push(sendEmail(env, meta.notifyEmail, `${verb}: ${order.productName}`,
      `${verb} taken by the ${name} phone assistant.\n\n${bookingSummary(order)}\n`).catch(logFail('booking email')));
  }
  if (order.callbackPhone) {
    const when = order.scheduledAt ? ` for ${formatSlotLabel(order.scheduledAt)}` : '';
    const text = event === 'cancelled'
      ? `${name}: your ${order.productName}${when} is cancelled.`
      : `${name}: you're booked for ${order.productName}${when}.${meta?.address ? ` ${meta.address}.` : ''}${meta?.phone ? ` Questions: ${meta.phone}.` : ''}`;
    jobs.push(sendSms(env, order.callbackPhone, text).catch(logFail('confirmation text')));
  }
  await Promise.all(jobs);
}

export async function notifyMessage(
  env: Env, meta: SectorMeta | null | undefined,
  msg: { callerName?: string | null; callbackPhone?: string | null; message: string },
): Promise<void> {
  if (!meta?.notifyEmail) return;
  await sendEmail(env, meta.notifyEmail, `Phone message from ${msg.callerName ?? 'a caller'}`,
    `Message left with the ${meta.name} phone assistant.\n\nFrom: ${msg.callerName ?? 'not given'}\nCallback: ${msg.callbackPhone ?? 'not given'}\n\n${msg.message}\n`,
  ).catch(logFail('message email'));
}
