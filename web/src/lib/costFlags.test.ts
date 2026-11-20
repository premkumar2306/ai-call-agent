import { describe, expect, it } from 'vitest';
import { flagOutliers, median, type FlagRow } from './costFlags';

const row = (id: string, costPaise: number, over: Partial<FlagRow> = {}): FlagRow =>
  ({ id, channel: 'voice', provider: 'twilio', billable: true, durationSeconds: 60, costPaise, marginPaise: 100, ...over });

describe('flagOutliers', () => {
  it('median', () => { expect([median([]), median([3]), median([1, 9, 2]), median([1, 2, 3, 10])]).toEqual([0, 3, 2, 2.5]); });
  it('flags a call over 2× the median cost per minute, not one at exactly 2×', () => {
    const f = flagOutliers([row('a', 100), row('b', 100), row('c', 100), row('d', 201), row('e', 200)]);
    expect([...f.keys()]).toEqual(['d']);
  });
  it('flags negative margin, even when the cost is typical', () => {
    const f = flagOutliers([row('a', 100), row('b', 100), row('c', 100, { marginPaise: -5 })]);
    expect(f.get('c')).toMatch(/negative margin/);
  });
  it('cost per minute uses call length, so a long call is not flagged for being big', () => {
    expect(flagOutliers([row('a', 100), row('b', 100), row('c', 100), row('d', 300, { durationSeconds: 180 })]).size).toBe(0);
  });
  it('ignores test calls and WhatsApp, and needs 3 calls for a median', () => {
    expect(flagOutliers([row('a', 100), row('b', 9999)]).size).toBe(0);
    expect(flagOutliers([row('a', 100), row('b', 100), row('c', 100), row('t', 9999, { provider: 'web', marginPaise: 0 }), row('w', 9999, { channel: 'whatsapp' })]).size).toBe(0);
  });
});
