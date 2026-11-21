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
