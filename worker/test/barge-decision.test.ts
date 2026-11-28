import { describe, expect, it } from 'vitest';
import { bargeInDecision } from '../src/durable-objects/stt-deepgram';

const live = { interim: true, confidence: 0.9, minConfidence: 0.5 };

describe('bargeInDecision (interim barge-in on)', () => {
  it('a single stop word interrupts (English and Hindi)', () => {
    for (const w of ['stop', 'Wait.', 'hold']) expect(bargeInDecision(w, 2, 'en', undefined, live)).toMatchObject({ interrupt: true, reason: 'stop_word' });
    expect(bargeInDecision('रुको', 2, 'hi', undefined, live)).toMatchObject({ interrupt: true, reason: 'stop_word' });
  });
  it('risky one-word utterances do not', () => {
    for (const w of ['no', 'hello', 'sorry', 'table']) expect(bargeInDecision(w, 2, 'en', undefined, live)).toMatchObject({ interrupt: false, reason: 'too_few_words' });
  });
  it('needs 3 words and confidence', () => {
    expect(bargeInDecision('I need', 2, 'en', undefined, live)).toMatchObject({ interrupt: false });
    expect(bargeInDecision('I need to change it', 2, 'en', undefined, live)).toMatchObject({ interrupt: true, reason: 'enough_words' });
    expect(bargeInDecision('I need to change it', 2, 'en', undefined, { ...live, confidence: 0.2 })).toMatchObject({ interrupt: false, reason: 'low_confidence' });
  });
  it('listener feedback and echo never interrupt', () => {
    expect(bargeInDecision('uh huh', 2, 'en', undefined, live)).toMatchObject({ interrupt: false, reason: 'backchannel' });
    expect(bargeInDecision('we are open every weekday', 2, 'en', () => true, live)).toMatchObject({ interrupt: false, reason: 'echo' });
  });
});

describe('bargeInDecision (default: interim barge-in off)', () => {
  it('is the historical rule: min words, no stop words', () => {
    expect(bargeInDecision('stop', 2, 'en')).toMatchObject({ interrupt: false, reason: 'too_few_words' });
    expect(bargeInDecision('I need', 2, 'en')).toMatchObject({ interrupt: true, reason: 'enough_words' });
  });
});

describe('bargeInDecision descriptor', () => {
  it('reports which word list matched and the confidence, never needs the text', () => {
    expect(bargeInDecision('uh huh', 2, 'en', undefined, live)).toMatchObject({ lexicon: 'backchannel', confidence: 0.9 });
    expect(bargeInDecision('stop', 2, 'en', undefined, live)).toMatchObject({ lexicon: 'stop' });
    expect(bargeInDecision('I need to change it', 2, 'en', undefined, live)).toMatchObject({ lexicon: 'none' });
    expect(bargeInDecision('I need to change it', 2, 'en').confidence).toBeUndefined();
  });
});

describe('bargeInDecision at LOW interruption sensitivity', () => {
  const low = { level: 'low' as const, confidence: 0.95, voicedMs: 600 };
  it('listener feedback, including "haan", "ji", "yes", never interrupts', () => {
    for (const w of ['haan', 'ji', 'accha', 'ok', 'yes', 'hmm', 'haan ji', 'ok ji']) expect(bargeInDecision(w, 2, 'hi-en', undefined, low)).toMatchObject({ interrupt: false, reason: 'backchannel' });
  });
  it('two or more words interrupt; one ordinary word does not', () => {
    expect(bargeInDecision('ruko, ek minute', 2, 'hi-en', undefined, low)).toMatchObject({ interrupt: true, reason: 'enough_words' });
    expect(bargeInDecision('table', 2, 'en', undefined, low)).toMatchObject({ interrupt: false, reason: 'too_few_words' });
  });
  it('one stop word needs high confidence, and Sarvam (no confidence) never gets the one-word rule', () => {
    expect(bargeInDecision('stop', 2, 'en', undefined, low)).toMatchObject({ interrupt: true, reason: 'stop_word' });
    expect(bargeInDecision('stop', 2, 'en', undefined, { ...low, confidence: 0.7 })).toMatchObject({ interrupt: false });
    expect(bargeInDecision('रुको', 2, 'hi', undefined, { level: 'low', voicedMs: 600 })).toMatchObject({ interrupt: false, reason: 'too_few_words' });
  });
  it('needs 350 ms of voiced audio and a confident transcript', () => {
    expect(bargeInDecision('ruko ek minute', 2, 'hi-en', undefined, { ...low, voicedMs: 200 })).toMatchObject({ interrupt: false, reason: 'too_short' });
    expect(bargeInDecision('ruko ek minute', 2, 'hi-en', undefined, { ...low, minConfidence: 0.5, confidence: 0.3 })).toMatchObject({ interrupt: false, reason: 'low_confidence' });
  });
  it('NORMAL is unchanged: "haan" alone is still not a backchannel for English, a stop word still needs interim mode', () => {
    expect(bargeInDecision('stop', 2, 'en')).toMatchObject({ interrupt: false, reason: 'too_few_words' });
    expect(bargeInDecision('yes', 2, 'en')).toMatchObject({ interrupt: false, reason: 'too_few_words' });
  });
});
