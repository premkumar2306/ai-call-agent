import { describe, expect, it } from 'vitest';
import { isSubstantialSpeech } from '../src/durable-objects/call-relay';

// #12 shipped barge-in defaulting to Deepgram's raw VAD event. On a PSTN
// line Twilio does not echo-cancel the inbound track against what we play,
// so the assistant's own voice returns up the caller's handset, trips VAD,
// and aborts the greeting — dead air on every call.
//
// Two changes guard that: the default mode is back to `final`, and `interim`
// now demands a transcript that looks like real words rather than any
// recognised fragment. These pin the second part.

describe('isSubstantialSpeech', () => {
  it('accepts two or more words', () => {
    expect(isSubstantialSpeech('I need')).toBe(true);
    expect(isSubstantialSpeech('cancel my appointment')).toBe(true);
  });

  it('accepts one long word', () => {
    expect(isSubstantialSpeech('appointment')).toBe(true);
    expect(isSubstantialSpeech('cancel')).toBe(true);
  });

  it('accepts short words people actually interrupt with', () => {
    // These fail the length rule, and are the most common real barge-ins.
    for (const word of ['wait', 'stop', 'no', 'hey', 'sorry', 'what']) {
      expect(isSubstantialSpeech(word), word).toBe(true);
    }
  });

  it('is not fooled by punctuation or case on those', () => {
    expect(isSubstantialSpeech('Wait!')).toBe(true);
    expect(isSubstantialSpeech('STOP')).toBe(true);
  });

  it('rejects a single short fragment', () => {
    // The shape a cough, a breath, or a clipped echo tends to produce.
    for (const noise of ['uh', 'um', 'a', 'the', 'mm', 'hm', 'er']) {
      expect(isSubstantialSpeech(noise), noise).toBe(false);
    }
  });

  it('rejects nothing at all', () => {
    expect(isSubstantialSpeech(undefined)).toBe(false);
    expect(isSubstantialSpeech('')).toBe(false);
    expect(isSubstantialSpeech('   ')).toBe(false);
  });

  it('ignores padding and repeated whitespace', () => {
    expect(isSubstantialSpeech('  hello   there  ')).toBe(true);
    expect(isSubstantialSpeech('\n uh \t')).toBe(false);
  });

  it('still lets a real interruption through', () => {
    // The case barge-in exists for: the caller cutting in mid-greeting.
    for (const real of [
      'wait',                      // one long word
      'no I wanted',
      'can you check my booking',
      'actually',
    ]) {
      expect(isSubstantialSpeech(real), real).toBe(true);
    }
  });
});
