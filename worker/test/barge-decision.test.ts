import { describe, expect, it } from 'vitest';
import { bargeInDecision } from '../src/durable-objects/stt-deepgram';

describe('bargeInDecision', () => {
  it('a single stop word interrupts (English and Hindi)', () => {
    for (const w of ['stop', 'Wait.', 'no', 'hello', 'रुको', 'नहीं']) {
      expect(bargeInDecision(w, 2, w === 'रुको' || w === 'नहीं' ? 'hi' : 'en')).toMatchObject({ interrupt: true, reason: 'stop_word' });
    }
  });
  it('a cough-length or stray single word does not', () => {
    expect(bargeInDecision('table', 2, 'en')).toMatchObject({ interrupt: false, reason: 'too_few_words' });
  });
  it('listener feedback and echo never interrupt', () => {
    expect(bargeInDecision('uh huh', 2, 'en')).toMatchObject({ interrupt: false, reason: 'backchannel' });
    expect(bargeInDecision('we are open every weekday', 2, 'en', () => true)).toMatchObject({ interrupt: false, reason: 'echo' });
  });
  it('enough words interrupt, and the threshold is reported', () => {
    expect(bargeInDecision('I need to change it', 2, 'en')).toMatchObject({ interrupt: true, reason: 'enough_words', words: 5, threshold: 2 });
  });
});
