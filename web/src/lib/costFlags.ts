// Cost-per-call outlier flags: a call is flagged when its cost per minute is
// over 2× the median of the month's phone calls, or when its margin is negative.

export interface FlagRow { id: string; channel: string; provider: string | null; billable: boolean; durationSeconds: number; costPaise: number; marginPaise: number }

const isPhoneCall = (r: FlagRow) => r.channel === 'voice' && r.provider !== 'web' && r.durationSeconds > 0;
export const costPerMinute = (r: FlagRow) => r.costPaise / (r.durationSeconds / 60);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** id → why it is flagged. Test calls, WhatsApp and unbilled (synthetic) calls are never flagged for margin. */
export function flagOutliers(rows: FlagRow[]): Map<string, string> {
  const phone = rows.filter(isPhoneCall);
  const med = median(phone.map(costPerMinute));
  const flags = new Map<string, string>();
  for (const r of phone) {
    const reasons: string[] = [];
    if (phone.length >= 3 && med > 0 && costPerMinute(r) > 2 * med) reasons.push('cost per minute is over 2× the median');
    if (r.billable && r.marginPaise < 0) reasons.push('negative margin');
    if (reasons.length) flags.set(r.id, reasons.join('; '));
  }
  return flags;
}
