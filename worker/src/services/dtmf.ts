// Keypad digits on a live call (all carriers send them as one normalised
// event). Pure decisions only; CallRelay does the I/O.
//
//   0                      → ask for staff (always, if the business has a staff line)
//   digits, after the assistant asked for a number or date, and the business
//   has dtmf_input on      → collected and handed to the turn as the answer
//   anything else          → ignored

export type DtmfAction = 'transfer' | 'collect' | 'submit' | 'ignore';

export interface DtmfContext {
  /** The business has a staff line to transfer to (sectors.phone). */
  hasStaffLine: boolean;
  /** sectors.dtmf_input: off unless the business turned it on. */
  inputEnabled: boolean;
  /** Something is being collected already (digits pressed, not yet submitted). */
  collecting: boolean;
  /** What the assistant said last (and may still be saying). */
  lastAssistantText: string;
}

const ASKS_FOR_DIGITS = /\b(phone|mobile|contact|callback|number|digits|date|birth ?day|birth ?date|dob|pin|zip ?code|postal code|pincode)\b/i;

/** The assistant's last words ask for a number or a date. */
export function asksForDigits(text: string): boolean {
  return text.includes('?') && ASKS_FOR_DIGITS.test(text);
}

export function dtmfAction(digit: string, ctx: DtmfContext): DtmfAction {
  if (digit === '0' && !ctx.collecting) return ctx.hasStaffLine ? 'transfer' : 'ignore';
  if (!ctx.inputEnabled) return 'ignore';
  if (digit === '#') return ctx.collecting ? 'submit' : 'ignore';
  if (!/^[0-9]$/.test(digit)) return 'ignore';
  return ctx.collecting || asksForDigits(ctx.lastAssistantText) ? 'collect' : 'ignore';
}

/** The pressed digits as the caller would have spoken them: "9 8 1 2…". */
export function digitsUtterance(digits: string): string {
  return digits.split('').join(' ');
}
