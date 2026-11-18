import { describe, expect, it } from 'vitest';
import { TwilioAdapter, ExotelAdapter, PlivoAdapter } from '../src/telephony';
import { asksForDigits, digitsUtterance, dtmfAction, type DtmfContext } from '../src/services/dtmf';

describe('DTMF events: one shape on every carrier', () => {
  it('Twilio', () => {
    expect(new TwilioAdapter().parse(JSON.stringify({ event: 'dtmf', streamSid: 'MZ1', dtmf: { track: 'inbound_track', digit: '5' } }))).toEqual({ type: 'dtmf', digit: '5' });
  });
  it('Exotel', () => {
    expect(new ExotelAdapter().parse(JSON.stringify({ event: 'dtmf', stream_sid: 's', dtmf: { duration: 200, digit: '#' } }))).toEqual({ type: 'dtmf', digit: '#' });
  });
  it('Plivo', () => {
    expect(new PlivoAdapter().parse(JSON.stringify({ event: 'dtmf', streamId: 's', dtmf: { digit: '0' } }))).toEqual({ type: 'dtmf', digit: '0' });
  });
  it('junk digits are dropped', () => {
    for (const a of [new TwilioAdapter(), new ExotelAdapter(), new PlivoAdapter()]) {
      expect(a.parse(JSON.stringify({ event: 'dtmf', dtmf: { digit: 'AB' } }))).toBeNull();
      expect(a.parse(JSON.stringify({ event: 'dtmf' }))).toBeNull();
    }
  });
});

describe('dtmfAction', () => {
  const ctx = (o: Partial<DtmfContext> = {}): DtmfContext => ({ hasStaffLine: true, inputEnabled: false, collecting: false, lastAssistantText: '', ...o });
  it('0 transfers when there is a staff line, with no setting needed', () => {
    expect(dtmfAction('0', ctx())).toBe('transfer');
    expect(dtmfAction('0', ctx({ hasStaffLine: false }))).toBe('ignore');
  });
  it('other digits are ignored unless the business turned input on', () => {
    expect(dtmfAction('5', ctx({ lastAssistantText: "What's your phone number?" }))).toBe('ignore');
  });
  it('with input on, digits answer a number or date question only', () => {
    const on = ctx({ inputEnabled: true });
    expect(dtmfAction('5', { ...on, lastAssistantText: "What's your phone number?" })).toBe('collect');
    expect(dtmfAction('5', { ...on, lastAssistantText: 'What date works for you?' })).toBe('collect');
    expect(dtmfAction('5', { ...on, lastAssistantText: 'Would you like a morning slot?' })).toBe('ignore');
    expect(dtmfAction('5', { ...on, lastAssistantText: 'We open at nine.' })).toBe('ignore');
  });
  it('once collecting: more digits collect, # submits, 0 is a digit not a transfer', () => {
    const c = ctx({ inputEnabled: true, collecting: true });
    expect(dtmfAction('0', c)).toBe('collect');
    expect(dtmfAction('#', c)).toBe('submit');
    expect(dtmfAction('*', c)).toBe('ignore');
    expect(dtmfAction('#', ctx({ inputEnabled: true }))).toBe('ignore');
  });
  it('helpers', () => {
    expect(asksForDigits('What number should I use?')).toBe(true);
    expect(asksForDigits('Your number is saved.')).toBe(false);
    expect(digitsUtterance('9812')).toBe('9 8 1 2');
  });
});
