import { toMinorUnits } from './business';

export interface ParsedService { name: string; priceCents: number; durationMinutes: number }
export interface BadLine { line: string; reason: string }

const SPLIT = /\s*[,|\t]\s*|\s+[-–—]\s+/;
const ON_REQUEST = /^(on request|varies|vary|tbd|ask|call)$/i;

function parsePrice(s: string): number | null {
  if (ON_REQUEST.test(s.trim())) return 0;
  return toMinorUnits(s.replace(/^(rs\.?|inr|usd|₹|\$)\s*/i, '').replace(/\/-$/, ''));
}

function parseMinutes(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\s*(min|mins|minutes|m)?$/i);
  const n = m ? parseInt(m[1], 10) : 0;
  return n > 0 && n <= 600 ? n : null;
}

// "Cleaning - 800 - 30", "Root canal, 4500, 60min", "Consultation, 500" (30 min assumed).
export function parseServiceLines(text: string): { good: ParsedService[]; bad: BadLine[] } {
  const good: ParsedService[] = [];
  const bad: BadLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Grouping commas (1,000 / 1,00,000) are part of a number, not separators.
    const line = raw.trim().replace(/(?<!\d)\d{1,3}(?:,\d{2})*,\d{3}(?!\d)/g, m => m.replace(/,/g, ''));
    if (!line) continue;
    const parts = line.split(SPLIT).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) { bad.push({ line, reason: 'Needs a name and a price' }); continue; }
    const withDuration = parts.length >= 3;
    const price = parsePrice(parts[withDuration ? parts.length - 2 : 1]);
    const duration = withDuration ? parseMinutes(parts[parts.length - 1]) : 30;
    const name = (withDuration ? parts.slice(0, -2) : parts.slice(0, 1)).join(' - ').slice(0, 120);
    if (price === null) bad.push({ line, reason: 'Price not understood' });
    else if (duration === null) bad.push({ line, reason: 'Minutes not understood' });
    else good.push({ name, priceCents: price, durationMinutes: duration });
  }
  return { good, bad };
}
