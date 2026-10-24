import { describe, expect, it } from 'vitest';
import { validateTwilioSignature } from '../src/routes/twilio';
// @ts-expect-error — plain JS diagnostic script, no types
import { twilioSignature } from '../scripts/diagnose-voice.mjs';

// The diagnostic script is only worth anything if a signature it produces is
// one the Worker actually accepts. If these drift apart, the script reports a
// signature failure that a real Twilio call would not have, and sends whoever
// runs it chasing a problem that isn't there.
//
// The Worker's validateTwilioSignature is the reference here, not a published
// test vector: it is the implementation that has been serving this line, so
// agreeing with it is what makes the script's verdict trustworthy.

const TOKEN = 'test-auth-token-0123456789';
const URL_ = 'https://mogi-platform.example.workers.dev/twilio/inbound';
const PARAMS = {
  CallSid: 'CA00000000000000000000000000000000',
  AccountSid: 'AC00000000000000000000000000000000',
  From: '+13125550123',
  To: '+13126854305',
  CallStatus: 'ringing',
  Direction: 'inbound',
};

describe('diagnose-voice signing round-trips with the Worker verifier', () => {
  it('produces a signature the Worker accepts', async () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS);
    expect(await validateTwilioSignature(TOKEN, sig, URL_, PARAMS)).toBe(true);
  });

  it('agrees with the Worker on a URL that carries a query string', async () => {
    // Twilio signs the full URL including the query, and checkSig() appends
    // the request's search string — so this shape has to round-trip too.
    const url = `${URL_}?token=abc123`;
    const sig = twilioSignature(TOKEN, url, PARAMS);
    expect(await validateTwilioSignature(TOKEN, sig, url, PARAMS)).toBe(true);
  });

  it('rejects a signature made with the wrong auth token', async () => {
    const sig = twilioSignature('wrong-token', URL_, PARAMS);
    expect(await validateTwilioSignature(TOKEN, sig, URL_, PARAMS)).toBe(false);
  });

  it('rejects a signature made for a different URL — the rename failure mode', async () => {
    // Exactly what a stale TWILIO_WEBHOOK_URL looks like: same token, same
    // params, host differs by one word.
    const sig = twilioSignature(TOKEN, URL_.replace('mogi', 'avery'), PARAMS);
    expect(await validateTwilioSignature(TOKEN, sig, URL_, PARAMS)).toBe(false);
  });

  it('is order-independent in the params object', async () => {
    const reordered = Object.fromEntries(Object.entries(PARAMS).reverse());
    expect(twilioSignature(TOKEN, URL_, reordered)).toBe(twilioSignature(TOKEN, URL_, PARAMS));
  });
});
