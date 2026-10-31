import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, SectorMeta, SessionPayload } from '../src/types';

// ── Fake Anthropic client ───────────────────────────────────────────────────
// Each scripted step is one model response: optional text (streamed word by
// word) and an optional tool call. `abortAfter` aborts the given controller
// once that many text deltas have been streamed — a barge-in mid-reply.

type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> }; abortAfter?: [AbortController, number]; hang?: boolean };
let script: Step[] = [];
let requests: any[] = [];

vi.mock('../src/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config')>()),
  VOICE_MODEL_TIMEOUT_MS: 50,
  createAnthropic: () => ({
    messages: {
      stream(body: any, opts?: { signal?: AbortSignal }) {
        requests.push(structuredClone(body));
        const step = script.shift();
        if (!step) throw new Error('model called more times than scripted');
        const deltas = step.text ? step.text.split(/(?<= )/) : [];
        const content: any[] = [];
        if (step.text) content.push({ type: 'text', text: step.text });
        if (step.tool) content.push({ type: 'tool_use', id: `tu_${requests.length}`, name: step.tool.name, input: step.tool.input });
        const abortErr = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
        return {
          async *[Symbol.asyncIterator]() {
            let n = 0;
            for (const text of deltas) {
              if (opts?.signal?.aborted) throw abortErr();
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
              n++;
              if (step.abortAfter && n === step.abortAfter[1]) step.abortAfter[0].abort();
            }
            if (step.hang) {
              await new Promise<void>(resolve => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
            }
            if (opts?.signal?.aborted) throw abortErr();
          },
          async finalMessage() {
            return { content, stop_reason: step.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
          },
        };
      },
    },
  }),
}));

const { runTurn, INTERRUPTED_MARK, trimMessages, amendInterruptedReply } = await import('../src/services/turn.service');
const { createCallCache } = await import('../src/services/call-context');
const { buildBusinessProfile, describeLocalNow, formatPrice } = await import('../src/services/business-profile');
const { searchProducts } = await import('../src/services/catalog.service');
const { getAvailableSlots, pickSlots, checkWithinHours, formatSlotLabel } = await import('../src/services/tool-router.service');
const { isBackchannel, looksIncomplete, isEchoOf, isDiscourseOnly } = await import('../src/durable-objects/stt-deepgram');
const { executeTool, normalizePhone } = await import('../src/services/tool-router.service');
const { agentTools } = await import('../src/services/turn.service');
const { joinUtterances } = await import('../src/durable-objects/call-relay');

// ── Fixtures (mirrors the advanced_vtech seed) ──────────────────────────────

const META: SectorMeta = {
  name: 'Advanced VTech',
  model: 'mixed',
  categories: ['DIAGNOSTICS', 'MAINTENANCE', 'BRAKES', 'AC_HEATING', 'ENGINE'],
  hours: { mon: '7:30am–6pm', tue: '7:30am–6pm', wed: '7:30am–6pm', thu: '7:30am–6pm', fri: '7:30am–6pm', sat: '8am–4pm' },
  timezone: 'America/Chicago',
  currency: 'USD',
  address: '220 E Aptakisic Rd, Buffalo Grove, IL 60089',
  phone: '(847) 459-4900',
  website: 'https://www.advancedvtech.com',
};

const product = (p: Partial<Product> & Pick<Product, 'id' | 'name' | 'category' | 'priceCents'>): Product => ({
  businessType: 'advanced_vtech', vendorId: 'v', vendorName: 'Advanced VTech', type: 'SERVICE_APPOINTMENT',
  fulfillmentType: 'SERVICE_BOOKING', description: '', originalPriceCents: p.priceCents, isActive: true,
  durationMinutes: 60, ...p,
});

const PRODUCTS: Product[] = [
  product({ id: 'avtech-free-estimate', name: 'Free Vehicle Inspection & Estimate', category: 'DIAGNOSTICS', priceCents: 0, durationMinutes: 30, description: 'Complimentary multi-point inspection and written estimate — no charge, no commitment.' }),
  product({ id: 'avtech-diag-scan', name: 'Check Engine / Warning Light Diagnostic', category: 'DIAGNOSTICS', priceCents: 8900, originalPriceCents: 12000, durationMinutes: 30, description: 'Full OBD-II scan, technician review of all fault codes, printed report.' }),
  product({ id: 'avtech-oil-syn', name: 'Full Synthetic Oil Change', category: 'MAINTENANCE', priceCents: 8999, originalPriceCents: 11999, durationMinutes: 45, description: 'Up to 5 quarts full synthetic oil, OEM filter.', upsellProductId: 'avtech-brake-front' }),
  product({ id: 'avtech-brake-front', name: 'Brake Pad Replacement — Front Axle', category: 'BRAKES', priceCents: 27900, durationMinutes: 90, description: 'Premium ceramic pads both sides, resurface rotors if within spec.' }),
  product({ id: 'avtech-ac-service', name: 'A/C Inspection & Recharge', category: 'AC_HEATING', priceCents: 14900, description: 'Inspect A/C compressor, hoses, and cabin filter; recharge refrigerant.' }),
  product({ id: 'avtech-engine-replace', name: 'Engine Replacement (Call for Quote)', category: 'ENGINE', priceCents: 0, durationMinutes: 480, description: 'Full engine replacement using remanufactured or OEM units.' }),
];

const SESSION: SessionPayload = {
  sub: 'caller-1', businessType: 'advanced_vtech', iat: 0, exp: 0, account: { tier: 'BASIC', store_credit_cents: 0 },
};

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}

function freshCache() {
  const cache = createCallCache();
  cache.sectorMeta = META;
  cache.productsAll = PRODUCTS;
  cache.orders = [];
  cache.ordersLoaded = true;
  cache.bookedDatetimes = new Map();
  cache.calendarBusy = [];
  return cache;
}

const env = () => ({ CART: kv(), CACHE: kv() }) as any;

beforeEach(() => { script = []; requests = []; });

// ── Grounding ───────────────────────────────────────────────────────────────

describe('business profile', () => {
  const profile = buildBusinessProfile('advanced_vtech', META, PRODUCTS);

  it('carries the contact details the agent used to never see', () => {
    expect(profile).toContain('220 E Aptakisic Rd, Buffalo Grove, IL 60089');
    expect(profile).toContain('(847) 459-4900');
    expect(profile).toContain('advancedvtech.com');
    expect(profile).toContain('Monday 7:30am to 6pm');
    expect(profile).toContain('Sunday closed');
  });

  it('lists every service with its id, price and duration', () => {
    for (const p of PRODUCTS) expect(profile).toContain(`[id: ${p.id}]`);
    expect(profile).toContain('$89.99 (regularly $119.99)');
    expect(profile).toContain('about 45 min');
    expect(profile).toContain('Pairs well with: Brake Pad Replacement — Front Axle');
  });

  it('does not call a quote-on-request job free', () => {
    expect(formatPrice(PRODUCTS[0])).toBe('free');
    expect(formatPrice(PRODUCTS[5])).toBe('price quoted after inspection');
    // Real Advanced VTech catalog has no prices — "quotes"/"quoted" must not read as free.
    expect(formatPrice({ priceCents: 0, originalPriceCents: 0, name: 'Brake Repair', description: 'The shop quotes after inspecting the vehicle.' })).toBe('price quoted after inspection');
  });

  it('gives the model a weekday → date map in the business timezone', () => {
    // Thu 2026-10-29 23:30 in Chicago is already Friday in UTC.
    const s = describeLocalNow(new Date('2026-10-30T04:30:00Z'), 'America/Chicago');
    expect(s).toContain('today 2026-10-29');
    expect(s).toContain('tomorrow 2026-10-30');
    expect(s).toContain('Saturday 2026-10-31');
  });
});

describe('searchProducts', () => {
  const top = (q: string) => searchProducts(PRODUCTS, q)[0]?.id;

  it('maps how callers describe problems onto the catalog', () => {
    expect(top('my brakes are squeaking')).toBe('avtech-brake-front');
    expect(top('the check engine light is on')).toBe('avtech-diag-scan');
    expect(top('AC is blowing warm air')).toBe('avtech-ac-service');
    expect(top('oil change')).toBe('avtech-oil-syn');
    expect(top('can I get a general checkup')).toBe('avtech-free-estimate');
  });

  it('returns nothing for a query with no service words', () => {
    expect(searchProducts(PRODUCTS, 'what do you have')).toEqual([]);
  });
});

// ── Scheduling ──────────────────────────────────────────────────────────────

describe('availability', () => {
  // Thursday 2026-10-29, 10:00 in Chicago.
  const now = new Date('2026-10-29T15:00:00Z');
  const slots = () => getAvailableSlots({} as any, 'advanced_vtech', META, 60, new Map(), [], now);

  it('offers today after a lead time, starts at the real opening minute, skips closed days', async () => {
    const s = await slots();
    expect(s[0].datetime).toBe('2026-10-29T11:00:00');
    expect(s[0].label).toBe('today at 11:00 AM');
    expect(s.find(x => x.date === '2026-10-30')?.time).toBe('7:30 AM');
    expect(s.some(x => x.date === '2026-11-01')).toBe(false); // Sunday
  });

  it('reads out same-day times an hour apart but keeps the half hours bookable', async () => {
    const all = await slots();
    const { shown } = pickSlots(all, { preferredDate: '2026-11-02', timeOfDay: 'morning' });
    expect(shown.map(s => s.time)).toEqual(['7:30 AM', '8:30 AM', '9:30 AM']);
    expect(all.some(s => s.datetime === '2026-11-02T09:00:00')).toBe(true);
  });

  it('honours a preferred day and part of day', async () => {
    const { shown, matchedPreference } = pickSlots(await slots(), { preferredDate: '2026-10-31', timeOfDay: 'afternoon' });
    expect(matchedPreference).toBe(true);
    expect(shown.every(s => s.date === '2026-10-31' && s.minutes >= 12 * 60)).toBe(true);
  });

  it('flags when the preference cannot be met instead of silently offering other days', async () => {
    const { shown, matchedPreference } = pickSlots(await slots(), { preferredDate: '2026-11-01' });
    expect(matchedPreference).toBe(false);
    expect(shown[0].date).toBe('2026-11-02');
  });

  it('rejects bookings outside opening hours or in the past', () => {
    expect(checkWithinHours('2026-10-30T09:00:00', 60, META, now)).toBeNull();
    expect(checkWithinHours('2026-10-30T07:00:00', 60, META, now)).toBe('OUTSIDE_HOURS');
    expect(checkWithinHours('2026-10-31T15:30:00', 60, META, now)).toBe('OUTSIDE_HOURS'); // Sat closes 4pm
    expect(checkWithinHours('2026-11-01T10:00:00', 60, META, now)).toBe('OUTSIDE_HOURS'); // Sunday
    expect(checkWithinHours('2026-10-29T08:00:00', 60, META, now)).toBe('PAST_TIME');
  });

  it('labels wall-clock datetimes without a UTC shift', () => {
    expect(formatSlotLabel('2026-10-30T09:00:00')).toBe('Friday, Oct 30 at 9:00 AM');
    expect(formatSlotLabel('2026-10-30T17:30:00', '2026-10-29', '2026-10-30')).toBe('tomorrow at 5:30 PM');
  });
});

// ── Turn engine ─────────────────────────────────────────────────────────────

describe('runTurn', () => {
  it('grounds the model in the business profile and the caller-local date', async () => {
    script = [{ text: "We're at 220 East Aptakisic Road in Buffalo Grove." }];
    const res = await runTurn(env(), SESSION, 'CA1', 'where are you located', { cache: freshCache() });
    const system = requests[0].system.map((b: any) => b.text).join('\n');
    expect(system).toContain('220 E Aptakisic Rd');
    expect(system).toContain('Full Synthetic Oil Change [id: avtech-oil-syn] — $89.99');
    expect(system).toContain('Dates: today');
    expect(res.spokenResponse).toContain('Aptakisic');
    expect(res.committed).toBe(true);
  });

  it('keeps tool calls in history so the next turn knows the offered slots', async () => {
    const cache = freshCache();
    script = [{ tool: { name: 'check_availability', input: { service_id: 'avtech-oil-syn' } } }];
    const first = await runTurn(env(), SESSION, 'CA2', 'can I bring it in for an oil change', { cache });
    expect(first.spokenResponse).toMatch(/^I have openings for Full Synthetic Oil Change/);
    expect(requests.length).toBe(1); // direct tool reply: no second model call

    script = [{ text: 'Booked.' }];
    await runTurn(env(), SESSION, 'CA2', 'the first one', { cache });
    const sent = requests[1].messages;
    const toolResult = sent.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((b: any) => b.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(JSON.parse(toolResult.content).offered[0].datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    // Roles alternate and the only cache breakpoint in messages is on the last one.
    sent.forEach((m: any, i: number) => { if (i) expect(m.role).not.toBe(sent[i - 1].role); });
    const marked = sent.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.cache_control);
    expect(marked.length).toBe(1);
  });

  it('does not commit a turn the caller interrupted before hearing anything', async () => {
    const cache = freshCache();
    const ac = new AbortController();
    script = [{ text: 'Sure, our full synthetic oil change is eighty nine ninety nine.', abortAfter: [ac, 1] }];
    const res = await runTurn(env(), SESSION, 'CA3', 'I need an oil change', { cache, signal: ac.signal, heardText: () => '' });
    expect(res).toMatchObject({ interrupted: true, committed: false });
    expect(cache.messages).toEqual([]);
  });

  it('commits only what the caller heard when they barge in mid-reply', async () => {
    const cache = freshCache();
    const ac = new AbortController();
    script = [{ text: 'Our oil change is $89.99. It takes about forty five minutes. Want me to book it?', abortAfter: [ac, 8] }];
    const res = await runTurn(env(), SESSION, 'CA4', 'how much is an oil change', {
      cache, signal: ac.signal, heardText: () => 'Our oil change is $89.99.',
    });
    expect(res.committed).toBe(true);
    expect(cache.messages.at(-1)).toEqual({ role: 'assistant', content: `Our oil change is $89.99. ${INTERRUPTED_MARK}` });
  });

  it('rewrites an already-committed reply when its audio is cut off', async () => {
    const cache = freshCache();
    script = [{ text: 'We are open seven thirty to six on weekdays and eight to four on Saturday.' }];
    await runTurn(env(), SESSION, 'CA5', 'what are your hours', { cache });
    amendInterruptedReply(cache, 'We are open seven thirty to six on weekdays');
    expect(cache.messages.at(-1)?.content).toBe(`We are open seven thirty to six on weekdays ${INTERRUPTED_MARK}`);
    expect(cache.history.at(-1)?.content).toBe(`We are open seven thirty to six on weekdays ${INTERRUPTED_MARK}`);
  });

  it('still answers and records the turn when the model errors', async () => {
    const cache = freshCache();
    script = []; // stream() throws
    const chunks: string[] = [];
    const res = await runTurn(env(), SESSION, 'CA6', 'hello', { cache, onChunk: c => { chunks.push(c); } });
    expect(chunks.join(' ')).toMatch(/trouble/);
    expect(res.committed).toBe(true);
    expect(cache.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  // CA77419: "Let me check oil change times for you." then the next model
  // round hung, and the caller sat through silence until they hung up.
  it('apologises instead of going silent when a round stalls after a preamble', async () => {
    const cache = freshCache();
    script = [
      { text: 'Let me check oil change times for you.', tool: { name: 'check_availability', input: { service_id: 'avtech-oil-syn' } } },
      { hang: true },
    ];
    const chunks: string[] = [];
    const res = await runTurn({ ...env(), VOICE_DIRECT_TOOL_REPLY: '0' }, SESSION, 'CA7', 'yeah book the oil change', { cache, onChunk: c => { chunks.push(c); } });
    expect(chunks[0]).toBe('Let me check oil change times for you.');
    expect(chunks.at(-1)).toMatch(/taking longer/);
    expect(res.interrupted).toBe(false);
    expect(res.committed).toBe(true);
  });

  it('never speaks the model thinking aloud with raw ISO dates', async () => {
    const cache = freshCache();
    script = [{ text: "Wednesday is 2026-11-04, and 10 o'clock is 10:00. You're set for Wednesday at 10 AM." }];
    const chunks: string[] = [];
    await runTurn(env(), SESSION, 'CA9', 'oil change wednesday at 10', { cache, onChunk: c => { chunks.push(c); } });
    expect(chunks.join(' ')).not.toMatch(/2026-11-04/);
    expect(chunks.join(' ')).toMatch(/Wednesday at 10 AM/);
  });

  it('treats a caller abort during a stalled round as an interruption, not an error', async () => {
    const cache = freshCache();
    const ac = new AbortController();
    script = [{ hang: true }];
    setTimeout(() => ac.abort(), 10);
    const chunks: string[] = [];
    const res = await runTurn(env(), SESSION, 'CA8', 'hello', { cache, signal: ac.signal, onChunk: c => { chunks.push(c); } });
    expect(res.interrupted).toBe(true);
    expect(chunks).toEqual([]);
  });
});

describe('trimMessages', () => {
  it('never separates a tool_use from its tool_result', () => {
    const msgs: any[] = [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{}' }] },
      { role: 'assistant', content: 'd' },
    ];
    const out = trimMessages(msgs, 3);
    expect(out[0]).toEqual({ role: 'user', content: 'c' });
    expect(out.length).toBe(4);
  });
});

// ── Turn-taking ─────────────────────────────────────────────────────────────

describe('turn-taking helpers', () => {
  // CAbcf248: the agent's "I'm not sure what you mean by that, but I'm
  // available to help" came back through the speakerphone as caller speech.
  it('recognises our own words coming back as echo, not a caller picking an option', () => {
    const said = "I'm not sure what you mean by that, but I'm available to help.";
    expect(isEchoOf("I'm not by that, but I'm available Monday.", said)).toBe(true);
    expect(isEchoOf('all four corners', 'Front, rear, or all four corners?')).toBe(false);
    expect(isEchoOf("I'm available Monday morning for brakes", said)).toBe(false);
  });

  it('holds lone filler words instead of answering them', () => {
    for (const t of ['Well,', 'Um, so', 'and']) expect(isDiscourseOnly(t)).toBe(true);
    for (const t of ['Oh, no.', 'Well, Monday works', 'yes']) expect(isDiscourseOnly(t)).toBe(false);
  });

  it('treats listener feedback as backchannel, real answers as speech', () => {
    for (const t of ['uh huh', 'Mm-hmm.', 'okay', 'yeah got it', 'Right.']) expect(isBackchannel(t)).toBe(true);
    for (const t of ['okay book it', 'no', 'yeah tuesday works', 'what about Saturday', '']) expect(isBackchannel(t)).toBe(false);
  });

  it('holds fragments from the 2026-10-30 call, answers finished sentences', () => {
    for (const t of ['Oh, I forgot. I also wanna change my', 'Okay. I wanna I wanna change', 'just', 'just...', 'I need an oil change and'])
      expect(looksIncomplete(t)).toBe(true);
    for (const t of ['I wanna book an appointment for break change.', 'Full break on all four.', '09:30.', 'Yeah.', 'What time do you close?', 'the cooling and oil.'])
      expect(looksIncomplete(t)).toBe(false);
  });

  it('drops catalog search tools when the whole catalog is in the prompt', () => {
    const names = (n: number) => agentTools('advanced_vtech', META, n).map(t => t.name);
    expect(names(16)).not.toContain('search_services');
    expect(names(16)).toContain('check_availability');
    expect(names(0)).toContain('search_services');
    expect(names(500)).toContain('search_services');
  });

  it('joins a split utterance', () => {
    expect(joinUtterances('I need an oil change', ' for my Civic on Friday')).toBe('I need an oil change for my Civic on Friday');
    expect(joinUtterances('', 'hello')).toBe('hello');
  });
});

// ── Front desk ──────────────────────────────────────────────────────────────

describe('front desk details', () => {
  it('normalises spoken phone numbers to E.164', () => {
    expect(normalizePhone('(847) 555-1234')).toBe('+18475551234');
    expect(normalizePhone('1 847 555 1234')).toBe('+18475551234');
    expect(normalizePhone('555-1234')).toBeUndefined();
  });

  it('asks for a name before booking, and for a number when caller ID is withheld', async () => {
    const cache = freshCache();
    const at = '2026-11-02T09:00:00';
    const noName = await executeTool('book_appointment', { product_id: PRODUCTS[0].id, scheduled_at: at }, { ...SESSION, callerPhone: '+18475551234' }, env(), META, cache);
    expect(noName.error).toBe('DETAILS_REQUIRED');
    const noPhone = await executeTool('book_appointment', { product_id: PRODUCTS[0].id, scheduled_at: at, customer_name: 'Sam' }, SESSION, env(), META, cache);
    expect(noPhone.error).toBe('PHONE_REQUIRED');
  });

  it('hands a live call to staff during opening hours', async () => {
    const cache = freshCache();
    const res = await executeTool('transfer_to_staff', {}, SESSION, env(), { ...META, phone: '(847) 777-5000', hours: { mon: '12am–11:59pm', tue: '12am–11:59pm', wed: '12am–11:59pm', thu: '12am–11:59pm', fri: '12am–11:59pm', sat: '12am–11:59pm', sun: '12am–11:59pm' } }, cache);
    expect(res.success).toBe(true);
    expect(cache.transferTo).toBe('8477775000');
  });
});

describe('capacity', () => {
  it("blocks a time only once other customers fill it; the caller's own visit never blocks them", async () => {
    const now = new Date('2026-10-29T15:00:00Z');
    const booked = new Map([['2026-11-02T09:00', new Set(['someone-else'])]]);
    const one = await getAvailableSlots({} as any, 'advanced_vtech', META, 60, booked, [], now);
    expect(one.some(s => s.datetime === '2026-11-02T09:00:00')).toBe(false);
    const two = await getAvailableSlots({} as any, 'advanced_vtech', { ...META, capacity: 2 }, 60, booked, [], now);
    expect(two.some(s => s.datetime === '2026-11-02T09:00:00')).toBe(true);
    const mine = new Map([['2026-11-02T09:00', new Set(['caller-1'])]]);
    const own = await getAvailableSlots({} as any, 'advanced_vtech', META, 60, mine, [], now, 'caller-1');
    expect(own.some(s => s.datetime === '2026-11-02T09:00:00')).toBe(true);
  });
});
