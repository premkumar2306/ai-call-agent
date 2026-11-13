import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, VARIANTS, fillTemplate, paramCount, validateTemplateBody, variantName } from '../src/services/whatsapp-templates';
import { followUpReason, formatWhen, wallClock } from '../src/services/whatsapp-outbound';
import { isOptIn, isOptOut } from '../src/routes/whatsapp';

describe('default templates', () => {
  it('meet Meta\'s structural rules in every language, with the same parameters', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const v of VARIANTS) {
        expect(validateTemplateBody(t.body[v]), `${t.family}/${v}`).toBeNull();
        expect(paramCount(t.body[v])).toBe(t.example.length);
      }
    }
  });
  it('Hinglish is a separate name in en', () => {
    expect(variantName('avery_appointment_reminder', 'hi-en')).toEqual({ name: 'avery_appointment_reminder_hinglish', language: 'en' });
    expect(variantName('avery_appointment_reminder', 'hi')).toEqual({ name: 'avery_appointment_reminder', language: 'hi' });
  });
  it('rejects a parameter at the start, gaps, and no opt-out line', () => {
    expect(validateTemplateBody('{{1}} is booked. Reply STOP to opt out.')).toMatch(/start or end/);
    expect(validateTemplateBody('Hi {{2}}, reply STOP')).toMatch(/numbered/);
    expect(validateTemplateBody('Hi {{1}}, see you soon')).toMatch(/opt out/);
  });
  it('fills parameters', () => {
    expect(fillTemplate('Hi {{1}}, at {{2}}.', ['A', 'B'])).toBe('Hi A, at B.');
  });
});

describe('formatWhen / wallClock', () => {
  it('says today / tomorrow in the business language', () => {
    expect(formatWhen('2026-11-18T10:30:00', 'en', '2026-11-17')).toMatch(/^tomorrow, 10:30\s?am$/i);
    expect(formatWhen('2026-11-18T10:30:00', 'hi', '2026-11-17')).toMatch(/^कल, /);
    expect(formatWhen('2026-11-18T10:30:00', 'hi-en', '2026-11-18')).toMatch(/^aaj, /);
    expect(formatWhen('2026-11-20T15:00', 'en')).toMatch(/Fri.*20 Nov.*3:00/);
  });
  it('wall clock in a timezone', () => {
    expect(wallClock(new Date('2026-11-17T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-18T00:00');
  });
});

describe('missed-call follow-up reason', () => {
  const base = { userTurns: 2, lastRole: 'assistant' as const, durationSec: 90, messageTaken: false, transferred: false, booked: false };
  it('message taken, unanswered, cut short', () => {
    expect(followUpReason({ ...base, messageTaken: true })).toBe('message');
    expect(followUpReason({ ...base, userTurns: 0, lastRole: null })).toBe('unanswered');
    expect(followUpReason({ ...base, lastRole: 'user' })).toBe('cut_short');
    expect(followUpReason({ ...base, durationSec: 12 })).toBe('cut_short');
  });
  it('never after a booking, a transfer, or a normal call', () => {
    expect(followUpReason(base)).toBeNull();
    expect(followUpReason({ ...base, userTurns: 0, booked: true })).toBeNull();
    expect(followUpReason({ ...base, messageTaken: true, transferred: true })).toBeNull();
  });
});

describe('opt-out / opt-in keywords (English, Hindi, Hinglish)', () => {
  it('opt-out', () => {
    for (const t of ['STOP', 'unsubscribe', 'बंद करो', 'बंद करें।', 'band karo', 'mat bhejo', 'अनसब्सक्राइब']) expect(isOptOut(t), t).toBe(true);
    for (const t of ['cancel', 'band kab hota hai?', 'मुझे अपॉइंटमेंट बंद करना है']) expect(isOptOut(t), t).toBe(false);
  });
  it('opt-in', () => {
    for (const t of ['START', 'start.', 'शुरू करो', 'shuru']) expect(isOptIn(t), t).toBe(true);
    expect(isOptIn('start my booking')).toBe(false);
  });
});
