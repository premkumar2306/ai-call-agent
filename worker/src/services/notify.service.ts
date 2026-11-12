import { HTTP_TIMEOUT_MS } from '../config';
import type { Env, Order, SectorMeta } from '../types';
import { formatSlotLabel } from './tool-router.service';
import { formatPhone, localeOf } from '../utils/locale';
import { bookingDetailLines } from './verticals';
import { privacyLinkSuffix } from './disclosure';
import { confirmBookingOnWhatsApp } from './whatsapp-api';
import { resolveVoiceSettings } from './voice-language';
import { hashId } from '../utils/identity';
import { customerHashSalt } from '../config';

// Tells people what the agent did: the business (email to the sector's
// notify_email) and the caller (text to their callback number). Each channel
// is optional and switches on when its credentials exist:
//   email — RESEND_API_KEY (+ EMAIL_FROM), and sectors.notify_email set
//   text  — TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM
// Failures are logged, never thrown: a booking is already made by the time
// anyone is told about it.

export type BookingEvent = 'booked' | 'rescheduled' | 'cancelled';

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
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

// Dates use the business locale; Indian callback numbers are grouped
// ("+91 98765 43210"). Defaults (en-US) give the same text as before.
export function bookingSummary(order: Order, meta?: SectorMeta | null): string {
  const locale = localeOf(meta).locale;
  const when = order.scheduledAt ? formatSlotLabel(order.scheduledAt, undefined, undefined, locale) : 'no time set';
  return [
    `${order.productName} — ${when}`,
    `Customer: ${order.customerName ?? 'not given'}`,
    ...bookingDetailLines(order),
    `Callback: ${order.callbackPhone ? formatPhone(order.callbackPhone) : 'not given'}`,
    order.notes ? `Notes: ${order.notes}` : '',
    `Booking ref: ${order.id.slice(0, 8)}`,
  ].filter(Boolean).join('\n');
}

export async function notifyBooking(env: Env, meta: SectorMeta | null | undefined, order: Order, event: BookingEvent): Promise<void> {
  // svt/latency-test.mjs bookings (see /admin/stream-token) tell nobody.
  if (order.customerIdHashed.startsWith('synthetic-latency-test')) return;
  const name = meta?.name ?? order.businessType;
  const verb = event === 'booked' ? 'New booking' : event === 'rescheduled' ? 'Booking moved' : 'Booking cancelled';
  const jobs: Promise<void>[] = [];
  if (meta?.notifyEmail) {
    jobs.push(sendEmail(env, meta.notifyEmail, `${verb}: ${order.productName}`,
      `${verb} taken by the ${name} phone assistant.\n\n${bookingSummary(order, meta)}\n`).catch(logFail('booking email')));
  }
  if (order.callbackPhone) {
    const when = order.scheduledAt ? ` for ${formatSlotLabel(order.scheduledAt, undefined, undefined, localeOf(meta).locale)}` : '';
    let text = event === 'cancelled'
      ? `${name}: your ${order.productName}${when} is cancelled.`
      : `${name}: you're booked for ${order.productName}${when}.${meta?.address ? ` ${meta.address}.` : ''}${meta?.phone ? ` Questions: ${meta.phone}.` : ''}`;
    // Empty unless the business has the DPDP notice on and a privacy URL set.
    text += privacyLinkSuffix(meta);
    jobs.push(sendSms(env, order.callbackPhone, text).catch(logFail('confirmation text')));
    // WhatsApp too, via the approved template — only once WA_CONFIRMATION_TEMPLATE is set.
    if (env.WA_CONFIRMATION_TEMPLATE) {
      const phone = order.callbackPhone;
      jobs.push(hashId(phone.replace(/\D/g, ''), customerHashSalt(env)).then(phoneHash => confirmBookingOnWhatsApp(env, {
        businessType: order.businessType, phone, phoneHash, text, lang: resolveVoiceSettings(meta).language,
      })).then(() => undefined).catch(logFail('WhatsApp confirmation')));
    }
  }
  await Promise.all(jobs);
}

export async function notifyMessage(
  env: Env, meta: SectorMeta | null | undefined,
  msg: { callerName?: string | null; callbackPhone?: string | null; message: string; updated?: boolean },
): Promise<void> {
  if (!meta?.notifyEmail) return;
  await sendEmail(env, meta.notifyEmail, `${msg.updated ? 'Updated phone message' : 'Phone message'} from ${msg.callerName ?? 'a caller'}`,
    `Message left with the ${meta.name} phone assistant.\n\nFrom: ${msg.callerName ?? 'not given'}\nCallback: ${msg.callbackPhone ? formatPhone(msg.callbackPhone) : 'not given'}\n\n${msg.message}\n`,
  ).catch(logFail('message email'));
}
