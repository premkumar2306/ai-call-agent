// Pure billing maths: periods, minutes, overage, GST, GSTIN validation and
// provider-cost estimates. No I/O here, so all of it is unit-tested
// (test/billing.test.ts).

export const BILLING_TIMEZONE = 'Asia/Kolkata';

export interface PlanTerms {
  monthlyFeePaise: number;
  includedMinutes: number;
  overagePaisePerMinute: number;
  gstRateBps: number; // 1800 = 18%
}

/** 'YYYY-MM' of the calendar month `at` falls in, in India time. Usage rolls up by this. */
export function billingPeriod(at: Date, timeZone = BILLING_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  return `${y}-${m}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function isPeriod(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Per-call rounding: every started minute is billed (telecom convention). */
export function billableMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

/** GST on an amount, rounded to the nearest paisa. */
export function gstOn(amountPaise: number, gstRateBps: number): number {
  return Math.round((amountPaise * gstRateBps) / 10_000);
}

export function withGst(amountPaise: number, gstRateBps: number): number {
  return amountPaise + gstOn(amountPaise, gstRateBps);
}

export interface Overage {
  minutesUsed: number;
  includedMinutes: number;
  overageMinutes: number;
  overagePaise: number; // excl. GST
  gstPaise: number;
  totalPaise: number;   // incl. GST
}

export function computeOverage(plan: PlanTerms, minutesUsed: number): Overage {
  const used = Math.max(0, Math.floor(minutesUsed));
  const overageMinutes = Math.max(0, used - plan.includedMinutes);
  const overagePaise = overageMinutes * plan.overagePaisePerMinute;
  const gstPaise = gstOn(overagePaise, plan.gstRateBps);
  return {
    minutesUsed: used, includedMinutes: plan.includedMinutes,
    overageMinutes, overagePaise, gstPaise, totalPaise: overagePaise + gstPaise,
  };
}

/** Soft-limit level reached: 0 (below 80%), 80 or 100. A plan with 0 included minutes never alerts. */
export function usageAlertLevel(minutesUsed: number, includedMinutes: number): 0 | 80 | 100 {
  if (includedMinutes <= 0) return 0;
  if (minutesUsed >= includedMinutes) return 100;
  if (minutesUsed * 100 >= includedMinutes * 80) return 80;
  return 0;
}

// ── GSTIN ───────────────────────────────────────────────────────────────────
// 15 chars: 2-digit state code, 10-char PAN, entity number, 'Z', check char.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function normalizeGstin(s: string): string {
  return s.trim().toUpperCase();
}

export function isValidGstin(s: string): boolean {
  const g = normalizeGstin(s);
  return GSTIN_RE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

export function gstinStateCode(gstin: string | null | undefined): string | null {
  return gstin && isValidGstin(gstin) ? normalizeGstin(gstin).slice(0, 2) : null;
}

export interface GstSplit { cgst: number; sgst: number; igst: number }

/**
 * Intra-state supply is CGST + SGST (half each), inter-state is IGST. Without
 * both state codes we can't tell, so the full amount is shown as IGST.
 */
export function splitGst(gstPaise: number, supplierStateCode: string | null, customerStateCode: string | null): GstSplit {
  if (supplierStateCode && customerStateCode && supplierStateCode === customerStateCode) {
    const cgst = Math.floor(gstPaise / 2);
    return { cgst, sgst: gstPaise - cgst, igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: gstPaise };
}

export function formatInr(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Provider cost estimates ────────────────────────────────────────────────
// List prices in USD, overridable without a deploy via the BILLING_COST_RATES
// var (JSON, merged over these). They are estimates for the operator's margin
// view, not invoices from the providers.

export interface LlmRate { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }

export interface CostRates {
  usdToInr: number;
  telephonyPerMinute: Record<string, number>; // by provider
  sttPerSecond: number;              // default STT provider (Deepgram)
  ttsPerChar: number;                // default TTS provider (Cartesia)
  sttPerSecondByProvider: Record<string, number>;
  ttsPerCharByProvider: Record<string, number>;
  whatsappPerConversation: number;
  llm: Record<string, LlmRate>; // by model id; 'default' for unknown models
}

export const DEFAULT_COST_RATES: CostRates = {
  usdToInr: 88,
  telephonyPerMinute: { twilio: 0.0085, exotel: 0.006, plivo: 0.006, web: 0, default: 0.0085 }, // web: in-app test calls, no phone line
  sttPerSecond: 0.0077 / 60,     // Deepgram nova-3 streaming
  ttsPerChar: 0.00003,           // Cartesia sonic
  // Sarvam (Hindi lines): ~₹30/hour STT, ~₹15 per 10K characters TTS, at ₹88/USD.
  sttPerSecondByProvider: { deepgram: 0.0077 / 60, sarvam: 30 / 88 / 3600 },
  ttsPerCharByProvider: { cartesia: 0.00003, sarvam: 15 / 88 / 10_000 },
  whatsappPerConversation: 0,    // service conversations are free on Meta
  llm: {
    'claude-haiku-5-5': { inputPerMTok: 0.10, outputPerMTok: 0.50, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.10, cacheWritePerMTok: 1.25 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.10, cacheWritePerMTok: 2.5 },
    default: { inputPerMTok: 0.10, outputPerMTok: 0.50, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
  },
};

export function costRates(override?: string): CostRates {
  if (!override) return DEFAULT_COST_RATES;
  try {
    const o = JSON.parse(override) as Partial<CostRates>;
    return {
      ...DEFAULT_COST_RATES, ...o,
      telephonyPerMinute: { ...DEFAULT_COST_RATES.telephonyPerMinute, ...(o.telephonyPerMinute ?? {}) },
      sttPerSecondByProvider: { ...DEFAULT_COST_RATES.sttPerSecondByProvider, ...(o.sttPerSecondByProvider ?? {}) },
      ttsPerCharByProvider: { ...DEFAULT_COST_RATES.ttsPerCharByProvider, ...(o.ttsPerCharByProvider ?? {}) },
      llm: { ...DEFAULT_COST_RATES.llm, ...(o.llm ?? {}) },
    };
  } catch {
    console.error('[billing] BILLING_COST_RATES is not valid JSON; using defaults');
    return DEFAULT_COST_RATES;
  }
}

export interface LlmUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface UsageForCost {
  channel: 'voice' | 'whatsapp';
  provider?: string | null;      // telephony
  sttProvider?: string | null;   // deepgram | sarvam
  ttsProvider?: string | null;   // cartesia | sarvam
  durationSeconds: number;
  sttSeconds: number;
  ttsChars: number;
  llmModel?: string | null;
  llm: LlmUsage;
}

export function estimateCostUsdMicros(u: UsageForCost, rates: CostRates = DEFAULT_COST_RATES): number {
  const llmRate = (u.llmModel && rates.llm[u.llmModel]) || rates.llm.default;
  const llm = (u.llm.input * llmRate.inputPerMTok + u.llm.output * llmRate.outputPerMTok
    + u.llm.cacheRead * llmRate.cacheReadPerMTok + u.llm.cacheWrite * llmRate.cacheWritePerMTok) / 1e6;
  const sttRate = (u.sttProvider ? rates.sttPerSecondByProvider[u.sttProvider] : undefined) ?? rates.sttPerSecond;
  const ttsRate = (u.ttsProvider ? rates.ttsPerCharByProvider[u.ttsProvider] : undefined) ?? rates.ttsPerChar;
  let usd = llm + u.sttSeconds * sttRate + u.ttsChars * ttsRate;
  if (u.channel === 'voice') {
    const perMin = rates.telephonyPerMinute[u.provider ?? 'default'] ?? rates.telephonyPerMinute.default ?? 0;
    usd += billableMinutes(u.durationSeconds) * perMin;
  } else {
    usd += rates.whatsappPerConversation;
  }
  return Math.round(usd * 1e6);
}

/** The phone-line and AI-model parts of a cost (speech is the rest). */
export function costParts(u: UsageForCost, rates: CostRates = DEFAULT_COST_RATES): { telephony: number; llm: number } {
  const llmRate = (u.llmModel && rates.llm[u.llmModel]) || rates.llm.default;
  const llm = (u.llm.input * llmRate.inputPerMTok + u.llm.output * llmRate.outputPerMTok
    + u.llm.cacheRead * llmRate.cacheReadPerMTok + u.llm.cacheWrite * llmRate.cacheWritePerMTok) / 1e6;
  const telephony = u.channel === 'voice'
    ? billableMinutes(u.durationSeconds) * (rates.telephonyPerMinute[u.provider ?? 'default'] ?? rates.telephonyPerMinute.default ?? 0)
    : rates.whatsappPerConversation;
  return { telephony: Math.round(telephony * 1e6), llm: Math.round(llm * 1e6) };
}

/** micro-USD → paise at the configured exchange rate. */
export function usdMicrosToPaise(micros: number, rates: CostRates = DEFAULT_COST_RATES): number {
  return Math.round((micros / 1e6) * rates.usdToInr * 100);
}

// ── Tax invoices ────────────────────────────────────────────────────────────

/** Indian financial year (April–March, India time) as 'YY-YY', e.g. '26-27'. */
export function financialYear(at: Date, timeZone = BILLING_TIMEZONE): string {
  const [y, m] = billingPeriod(at, timeZone).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** 'AVY/26-27/000042': 16 characters, inside GST's 16-character invoice-number limit. */
export function formatInvoiceNumber(fy: string, seq: number, prefix = 'AVY'): string {
  return `${prefix}/${fy}/${String(seq).padStart(6, '0')}`;
}

/** Splits a GST-inclusive amount (what Razorpay charges) into taxable value + GST. */
export function splitInclusive(totalPaise: number, gstRateBps: number): { taxablePaise: number; gstPaise: number } {
  const taxablePaise = Math.round((totalPaise * 10_000) / (10_000 + gstRateBps));
  return { taxablePaise, gstPaise: totalPaise - taxablePaise };
}

export interface InvoiceLine { description: string; amountPaise: number } // excl. GST

export interface InvoiceTotals extends GstSplit {
  lines: InvoiceLine[]; taxablePaise: number; gstPaise: number; totalPaise: number;
}

/**
 * Builds a tax invoice from the GST-inclusive lines Razorpay charged. The
 * total is exactly what was paid; each line's taxable value is backed out and
 * any rounding paisa goes to the last line, so the lines add up.
 */
export function invoiceTotals(chargedLines: Array<{ description: string; totalPaise: number }>, gstRateBps: number,
  supplierStateCode: string | null, customerStateCode: string | null): InvoiceTotals {
  const totalPaise = chargedLines.reduce((s, l) => s + l.totalPaise, 0);
  const { taxablePaise, gstPaise } = splitInclusive(totalPaise, gstRateBps);
  const lines = chargedLines.map(l => ({ description: l.description, amountPaise: splitInclusive(l.totalPaise, gstRateBps).taxablePaise }));
  const drift = taxablePaise - lines.reduce((s, l) => s + l.amountPaise, 0);
  if (lines.length && drift) lines[lines.length - 1].amountPaise += drift;
  return { lines, taxablePaise, gstPaise, totalPaise, ...splitGst(gstPaise, supplierStateCode, customerStateCode) };
}

// ── Dunning ─────────────────────────────────────────────────────────────────

export const DEFAULT_GRACE_DAYS = 7;

export function graceDays(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : DEFAULT_GRACE_DAYS;
}
