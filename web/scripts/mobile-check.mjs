// Mobile layout check: serves the built app, mocks the API, visits every page and
// main dialog at phone/tablet widths in light and dark, and reports overflow.
//   npm run build && npm run mobile:check
// Fails (exit 1) on (a) page-level horizontal scroll or (b) an element past the
// right edge outside a scroll container. (c) small tap targets and (d) clipped
// text are reported only.  Options: --widths=360,375 --only=<substring> --verbose
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? d;
const WIDTHS = arg('widths', '360,375,414,768').split(',').map(Number);
const ONLY = arg('only', '');
const VERBOSE = process.argv.includes('--verbose');
const THEMES = arg('themes', 'light,dark').split(',');
const OUT = join(root, 'mobile-check');
const PORT = 4179;
const URL_BASE = `http://127.0.0.1:${PORT}`;

// ── Fixture data (deliberately long) ────────────────────────────────────────
const LONG_NAME = 'Dr. Lakshmi Narayanan Venkataraghavan Multi-Speciality Dental & Implant Centre, Anna Nagar West Extension';
const LONG_EMAIL = 'lakshmi.narayanan.venkataraghavan.frontdesk@annanagar-dental-implant-centre.example.co.in';
const LONG_URL = 'https://www.annanagar-dental-implant-centre.example.co.in/patients/privacy-notice/latest-version-2026?utm_source=whatsapp&utm_medium=booking-confirmation';
const HINDI = 'नमस्ते, मुझे अगले मंगलवार को दांतों की सफाई और जाँच के लिए अपॉइंटमेंट चाहिए, कृपया सुबह का समय बताइए';
const TAMIL = 'வணக்கம், எனக்கு அடுத்த வெள்ளிக்கிழமை பல் வலிக்காக மருத்துவரைப் பார்க்க நேரம் வேண்டும்';
const KEY = 'annanagar_dental_implant_centre_west_extension_chennai';
const KEY2 = 'second_clinic_with_an_equally_long_identifier_for_testing';
const OK = data => ({ success: true, data });
const now = Math.floor(Date.now() / 1000);
const day = 86400;
const iso = (d, h = 10) => { const x = new Date(Date.now() + d * day * 1000); return `${x.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:30:00`; };

const transcripts = Array.from({ length: 22 }, (_, i) => ({
  id: `t${i}`, callSid: i % 3 === 0 ? `wa:91987654${1000 + i}` : `CA${'a1b2c3d4e5f6'.repeat(3)}${i}`,
  customerIdHashed: `h${i % 7}`, businessType: KEY,
  turns: [
    { role: 'assistant', content: `Hello, thank you for calling ${LONG_NAME}. How can I help you today?` },
    { role: 'user', content: i % 2 ? HINDI : TAMIL },
    { role: 'assistant', content: 'Certainly. I can book that for you. Could you share your full name and a number we can reach you on, including the country code, please? ' + LONG_URL },
    { role: 'user', content: 'Verylongunbrokenwordwithoutanyspacesatallthatkeepsgoingandgoingandgoing_' + 'x'.repeat(60) },
  ],
  metrics: i === 1 ? null : [{ n: 1, at: 1, text: HINDI, queued: 12, laps: [['stt', 220], ['llm', 640]], firstAudio: 900, fillers: 1, outcome: 'done' }],
  createdAt: now - i * 5400, updatedAt: now - i * 5400 + 190,
}));
const bookings = Array.from({ length: 24 }, (_, i) => ({
  id: `b${i}`, businessType: KEY, customerIdHashed: `h${i % 7}`, productName: 'Root canal treatment with zirconia crown and follow-up X-ray (premium)',
  status: ['CONFIRMED', 'PENDING', 'CANCELLED'][i % 3], scheduledAt: iso(i % 9 - 2, 9 + (i % 8)), endsAt: iso(i % 9 - 2, 10 + (i % 8)),
  customerName: i % 2 ? 'Venkataraghavan Subramaniam Iyer-Krishnamurthy' : 'அருணாச்சலம் சுப்பிரமணியம்', vehicle: null,
  resourceName: 'Dr. Priyadarshini Chandrasekaran', details: { chief_complaint: HINDI }, callbackPhone: '+919876541000',
  notes: TAMIL, priceCents: 1250000, calendarSync: 'synced', createdAt: now - i * 3000, visitStatus: i % 4 === 0 ? 'completed' : null,
}));
const messages = Array.from({ length: 6 }, (_, i) => ({
  id: `m${i}`, businessType: KEY, callerName: 'Ramasubramanian Venkatakrishnan', callbackPhone: '+91987654320' + i,
  message: `${HINDI}. Email me at ${LONG_EMAIL}`, status: i < 4 ? 'NEW' : 'DONE', createdAt: now - i * 7000,
}));
const products = Array.from({ length: 22 }, (_, i) => ({
  id: `p${i}`, name: `Comprehensive full-mouth rehabilitation with digital smile design #${i}`, priceCents: 1850000 + i * 100, durationMinutes: 45 + i,
  description: 'Includes consultation, scans, temporary crowns and two follow-up reviews. ' + TAMIL, isActive: i % 5 !== 0, category: 'Restorative & cosmetic dentistry',
}));
const hours = { mon: '10am–1pm, 5pm–8pm', tue: '10am–1pm, 5pm–8pm', wed: '10am–1pm, 5pm–8pm', thu: '10am–1pm, 5pm–8pm', fri: '10am–1pm, 5pm–8pm', sat: '10am–1pm' };
const resources = Array.from({ length: 8 }, (_, i) => ({
  id: `r${i}`, name: 'Dr. Priyadarshini Chandrasekaran-Venkataraghavan', role: 'Senior Consultant Endodontist and Implantologist', hours, slotMinutes: 30,
  feeCents: 80000, about: TAMIL, categories: ['Restorative & cosmetic dentistry'], isActive: true,
}));
const sectorDetail = {
  key: KEY, name: LONG_NAME, kind: 'dental', vertical: 'clinic', currency: 'INR', locale: 'en-IN', countryCode: 'IN',
  address: '14/2, Third Avenue Extension Road, Anna Nagar West Extension, Chennai, Tamil Nadu 600101, India', phone: '+914426180000', website: LONG_URL,
  timezone: 'Asia/Kolkata', about: HINDI + ' ' + TAMIL, notifyEmail: LONG_EMAIL, capacity: 6, hours,
};
const members = [
  { userId: 'u1', email: LONG_EMAIL, name: 'Lakshmi Narayanan Venkataraghavan', role: 'owner', addedAt: '2026-01-02T00:00:00Z' },
  ...Array.from({ length: 5 }, (_, i) => ({ userId: `u${i + 2}`, email: `front.desk.coordinator.number${i}@annanagar-dental-implant-centre.example.co.in`, name: null, role: 'staff', addedAt: '2026-03-02T00:00:00Z' })),
];
const planFields = { id: 'plan_clinic_growth_annual_with_priority_support', name: 'Clinic Growth Plan with priority support and extra minutes', monthlyFeePaise: 499900, includedMinutes: 600, overagePaisePerMinute: 900, gstRateBps: 1800, checkoutReady: true };
const billing = {
  state: 'active', nextAction: 'upgrade', trialDaysLeft: null, nextCharge: { at: now + 10 * day, amountPaise: 589882 }, payment: null,
  overageAllowed: true, cancelAtPeriodEnd: false, pendingPlan: null, upgradeTo: { id: 'p2', name: 'Clinic Scale Plan' },
  taxInvoices: Array.from({ length: 12 }, (_, i) => ({ id: `ti${i}`, number: `AVY/2026-27/000${100 + i}`, issuedAt: now - i * 30 * day, taxablePaise: 499900, cgst: 44991, sgst: 44991, igst: 0, totalPaise: 589882, refundedPaise: 0 })),
  razorpayConfigured: true, razorpayKeyId: 'rzp_test_x', plan: { ...planFields, trialDays: 14, currency: 'INR', monthly: { amountPaise: 499900, gstPaise: 89982, totalPaise: 589882, cgst: 44991, sgst: 44991, igst: 0 }, setupFee: { ...{ amountPaise: 499900, gstPaise: 89982, totalPaise: 589882, cgst: 44991, sgst: 44991, igst: 0 }, waived: true }, isFeatured: true, audience: 'Clinics with up to 6 doctors' },
  offer: { code: 'LAUNCH-DENTAL-CHENNAI-2026', name: 'Launch offer for Chennai dental clinics', description: 'Two months free ' + TAMIL, freeDays: 60, waiveSetupFee: true, appliedAt: now },
  account: { trialEndsAt: null, subscriptionId: 'sub_x', subscriptionStatus: 'active', currentPeriodEnd: now + 10 * day, legalName: LONG_NAME + ' Private Limited', gstin: '33ABCDE1234F1Z5', billingEmail: LONG_EMAIL, addressLine1: '14/2, Third Avenue Extension Road', addressLine2: 'Anna Nagar West Extension', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600101', country: 'IN' },
  supplierGstin: '33ABCDE1234F1Z5', usage: { period: '2026-11', minutes: 650, calls: 188, whatsappConversations: 40, includedMinutes: 600, includedMinutesUsed: 600, includedMinutesLeft: 0, alertLevel: 100, overageSoFar: { ...{ amountPaise: 499900, gstPaise: 89982, totalPaise: 589882, cgst: 44991, sgst: 44991, igst: 0 }, minutes: 50 } },
  invoices: Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(12 - i).padStart(2, '0')}`, status: 'paid', ...{ amountPaise: 499900, gstPaise: 89982, totalPaise: 589882, cgst: 44991, sgst: 44991, igst: 0 }, minutesUsed: 412, includedMinutes: 600, overageMinutes: 0 })),
  cost: { usdToInr: 84, costPaise: 123456, costPerMinutePaise: 300, revenuePaise: 589882, revenuePerMinutePaise: 900, marginPaise: 400000, testCalls: 3 },
};
const plans = Array.from({ length: 5 }, (_, i) => ({ ...planFields, id: `pl${i}`, razorpayPlanId: `plan_${i}`, isActive: true, isDefault: i === 0, trialDays: 14, currency: 'INR' }));
const pilot = {
  config: { enabled: true, startsOn: '2026-11-01', endsOn: '2026-12-01', clinicNumber: '+914426180000', clinicLine: '+914426180001' }, active: true,
  averyNumbers: [{ number: '+918071234567', provider: 'exotel' }], clinicLines: ['+914426180000', '+914426180001'],
  recent: Array.from({ length: 10 }, (_, i) => ({ at: now - i * 900, carrier: 'exotel', isOverflow: i % 2 === 0, reason: 'busy', forwardedFrom: '+914426180000' })),
  forwardingTest: { status: 'received', startedAt: now - 600, expiresAt: now + 600 },
};
const waBusiness = {
  connected: true, number: { displayPhoneNumber: '+91 98765 43210', verifiedName: LONG_NAME, qualityRating: 'GREEN' },
  settings: { reminders: true, missedCallFollowup: true }, ready: { confirmation: true, reminder: true, cancellation: false, missed_call: true },
  previews: { confirmation: 'Hi ' + HINDI, reminder: 'Reminder: ' + TAMIL, cancellation: LONG_URL, missed_call: LONG_EMAIL },
};
const privacy = {
  aiDisclosure: null, disclosureEffective: true, legal: true, inIndia: true, disclosureText: null,
  defaultDisclosureText: 'This call is handled by an AI assistant for ' + LONG_NAME + ' and may be recorded to help us serve you better. ' + TAMIL,
  disclosureMaxChars: 400, privacyNoticeUrl: LONG_URL, retentionDays: 90, retentionLimits: { min: 7, max: 730 }, consentLogMinDays: 365,
};
const voice = { language: 'hi-en', sttProvider: 'sarvam', ttsProvider: 'sarvam', voiceId: 'anushka-with-a-very-long-identifier', sarvamConfigured: true };
const sectors = [{ key: KEY, name: LONG_NAME, kind: 'dental' }, { key: KEY2, name: 'Second Clinic: ' + LONG_NAME, kind: 'clinic' }, ...Array.from({ length: 22 }, (_, i) => ({ key: `biz_${i}_` + 'x'.repeat(40), name: `Business number ${i} – ${LONG_NAME}`, kind: 'lawyer' }))];

function api(path, method, role) {
  const p = path;
  const m = (re) => re.test(p);
  if (m(/^\/sectors$/)) return OK(sectors);
  if (m(/^\/account\/me$/)) return OK({ user: { id: 'u1', email: LONG_EMAIL, name: 'Lakshmi' }, businesses: role === 'noBiz' ? [] : sectors.slice(0, 2).map(s => ({ ...s, role: role === 'staff' ? 'staff' : 'owner' })) });
  if (m(/^\/account\/plans$/)) return OK({ plans: plans.map(x => ({ ...x })), offers: [] });
  if (m(/^\/account\/businesses\/[^/]+\/members/)) return OK(members);
  if (m(/^\/account\/businesses\/[^/]+\/number-request/)) return OK([{ id: 'n1', status: 'open', createdAt: '2026-11-01T00:00:00Z' }]);
  if (m(/^\/admin\/sectors\/[^/]+$/)) return OK({ ...sectorDetail, key: p.split('/')[3] });
  if (m(/^\/admin\/transcripts\//)) return OK(transcripts);
  if (m(/^\/admin\/bookings\//)) return OK(bookings);
  if (m(/^\/admin\/messages\//)) return OK(messages);
  if (m(/^\/admin\/products\//)) return OK(products);
  if (m(/^\/admin\/resources\//)) return OK(resources);
  if (m(/^\/admin\/config\//)) return OK({ storeName: LONG_NAME, greeting: HINDI, agentName: 'Avery', primaryColor: '#0b5fff', supportEmail: LONG_EMAIL, maxRecommendations: 3 });
  if (m(/^\/admin\/privacy\/[^/]+\/settings/)) return OK(privacy);
  if (m(/^\/admin\/privacy\/[^/]+\/notices/)) return OK(Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, channel: 'voice', call_sid: 'CA' + 'abcdef1234567890'.repeat(2) + i, played_at: now - i * 900, heard_fully: i % 2, erased: 0 })));
  if (m(/^\/admin\/sectors\/[^/]+\/voice/) || m(/voice/)) return OK(voice);
  if (m(/^\/billing\/[^/]+$/)) return OK(billing);
  if (m(/^\/admin\/billing\/accounts/)) return OK(Array.from({ length: 22 }, (_, i) => ({ businessType: i ? `biz_${i}_` + 'x'.repeat(40) : KEY, name: i ? `Business number ${i} – ${LONG_NAME}` : LONG_NAME, countryCode: 'IN', state: 'active', overageAllowed: true, plan: { id: 'p', name: plans[0].name, includedMinutes: 600 }, trialEndsAt: null, subscriptionStatus: 'active', cancelAtPeriodEnd: false, lastPaymentStatus: 'captured', minutes: 400, costPaise: 123456 })));
  if (m(/^\/admin\/billing\/calls\//)) return OK({ period: '2026-11', unallocatedFeePaise: 1200, rows: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, sourceId: 'CA' + 'ab12'.repeat(8) + i, channel: i % 3 ? 'voice' : 'whatsapp', provider: 'exotel', billable: true, startedAt: now - i * 900, durationSeconds: 120 + i, billableMinutes: 2, llmModel: 'claude-sonnet-5-5', costPaise: 4000, phonePaise: 1000, speechPaise: 1500, aiPaise: 1500, revenuePaise: 9000, marginPaise: 5000 })) });
  if (m(/^\/admin\/billing\/plans/) || m(/^\/admin\/plans/)) return OK(plans);
  if (m(/^\/billing\/[^/]+\/plans/)) return OK(plans.map(x => ({ ...x })));
  if (m(/^\/pilot\//)) return OK(pilot);
  if (m(/^\/metrics\/[^/]+\/settings/)) return OK({ weeklySummary: true, shareEnabled: true, shareToken: 'tok_' + 'x'.repeat(48) });
  if (m(/^\/metrics\//)) return OK({ window: { label: 'Last 30 days' }, hasPilot: true, settings: { weeklySummary: true, shareEnabled: true, shareToken: 'tok_' + 'x'.repeat(48) }, metrics: { calls: 188, answered: 181, answerRate: 0.96, overflowCalls: 41, afterHoursCalls: 33, transfers: 12, transferRate: 0.06, bookingsFromCalls: 57, recoveredBookings: 9, noShow: { status: 'ok', before: 0.21, after: 0.12 } } });
  if (m(/^\/features$/)) return OK({ hindi: true, calendar: true, whatsapp: true, billing: true, sms: true, email: true });
  if (m(/^\/admin\/whatsapp\/business\//)) return OK(waBusiness);
  if (m(/^\/admin\/whatsapp\/templates/)) return OK({ wabaConfigured: true, events: ['confirmation', 'reminder', 'cancellation', 'missed_call'].map(e => ({ event: e, family: 'avery_' + e, ready: e !== 'cancellation', variants: [{ variant: 'en', name: 'avery_' + e, language: 'en', status: 'APPROVED' }, { variant: 'hi', name: 'avery_' + e + '_hindi_long_template_name', language: 'hi', status: 'PENDING' }] })), defaults: ['confirmation', 'reminder', 'cancellation', 'missed_call'].map(e => ({ event: e, family: 'avery_' + e, example: ['x'], body: { en: 'Hi {{1}}, ' + LONG_URL, hi: HINDI } })), templates: Array.from({ length: 6 }, (_, i) => ({ name: 'avery_confirmation_long_template_name_' + i, language: 'en', variant: 'en', purpose: 'confirmation', category: 'UTILITY', status: 'APPROVED', body: HINDI, rejectedReason: i === 2 ? TAMIL : null })) });
  if (m(/^\/admin\/whatsapp\/health/)) return OK({ webhookFields: ['messages'], templates: ['confirmation', 'reminder', 'cancellation', 'missed_call'].map(e => ({ event: e, family: 'avery_' + e, ready: true, variants: [{ variant: 'en', name: 'avery_' + e + '_long_template_name', language: 'en', status: 'APPROVED' }] })), numbers: Array.from({ length: 3 }, (_, i) => ({ phoneNumberId: '10987654321098' + i, businessType: KEY, label: 'Main reception line for ' + LONG_NAME, displayPhoneNumber: '+91 98765 4321' + i, verifiedName: LONG_NAME, nameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED', error: null, checkedAt: now * 1000, lastMessageAt: now * 1000 })) });
  if (m(/^\/admin\/whatsapp-numbers/)) return OK(Array.from({ length: 21 }, (_, i) => ({ phoneNumberId: '10987654321098' + i, businessType: KEY, label: 'Main reception WhatsApp line for ' + LONG_NAME })));
  if (m(/^\/admin\/whatsapp-status/)) return OK({ appSecret: true, verifyToken: true, accessToken: false, phoneNumberMap: true, webhookPath: '/webhooks/whatsapp/' + 'x'.repeat(60), confirmationTemplate: true, templateLanguage: true, graphApiVersion: true, businessAccountId: false });
  if (m(/^\/admin\/number-requests/)) return OK(Array.from({ length: 21 }, (_, i) => ({ id: `nr${i}`, businessType: KEY, requestedBy: LONG_EMAIL, note: HINDI + ' ' + LONG_URL, status: i % 3 ? 'open' : 'done', createdAt: '2026-11-02T00:00:00Z' })));
  if (m(/^\/admin\/default-business/)) return OK({ selected: KEY, effective: KEY, envDefault: KEY2 });
  if (m(/^\/admin\/integrations$/)) return OK({ readiness: { score: 71, ready: false, blockers: [{ id: 'x', name: 'Integration with a very long service name', status: 'fail', reason: LONG_URL }] }, integrations: Array.from({ length: 12 }, (_, i) => ({ id: `svc${i}`, name: 'Integration with a very long service name ' + i, requirement: ['required', 'carrier', 'optional'][i % 3], unlocks: 'Everything about speech to text ' + TAMIL, getFrom: LONG_URL, doc: 'docs/' + 'x'.repeat(60) + '.md', cost: '₹1.2 / min (about $0.014) with volume discounts', settings: [{ name: 'VERY_LONG_SECRET_SETTING_NAME_FOR_THIS_INTEGRATION_' + i, required: true, purpose: HINDI, set: i % 2 === 0 }], missing: i % 2 ? ['VERY_LONG_SECRET_SETTING_NAME_FOR_THIS_INTEGRATION_' + i] : [], status: ['ok', 'fail', 'unchecked', 'not_configured'][i % 4], lastCheck: { ok: false, at: '2026-11-01T00:00:00Z', detail: LONG_URL } })) });
  if (m(/^\/admin\/phone-numbers$/)) return OK(Array.from({ length: 21 }, (_, i) => ({ number: '+9180712345' + (10 + i), provider: 'exotel', businessType: KEY, label: 'Reception line for ' + LONG_NAME })));
  if (m(/^\/clinic\/[^/]+\/?$/)) return OK({ durationBooking: true, recalls: true, recallMonths: 6, recallCategory: null, noShowRecovery: true, reviewRequests: true, reviewUrl: LONG_URL });
  if (m(/^\/practice\//)) return OK({ software: 'practo', confirmationMode: false, frontDeskPhone: '+914426180000', icsImport: true, icsUrlSet: true, icsUrlHost: 'calendar.annanagar-dental-implant-centre.example.co.in', icsLastSync: now * 1000, icsLastError: LONG_URL, icsBusyCount: 14 });
  if (m(/^\/admin\/calendar\/[^/]+\/calendars/)) return OK([{ id: 'c', name: LONG_NAME + ' – Appointments', primary: true }, { id: 'd', name: 'Holidays in India and other long calendar names', primary: false }]);
  if (m(/^\/admin\/calendar\//)) return OK({ providers: [{ id: 'google', name: 'Google Calendar', configured: true }], connection: { provider: 'google', accountEmail: LONG_EMAIL, calendarId: 'c', calendarName: LONG_NAME + ' – Appointments', checkBusy: true, writeEvents: true, status: 'active', lastError: null, updatedAt: '2026-11-01T00:00:00Z' } });
  if (m(/^\/admin\/calls\/[^/]+\/turns/)) return OK({ turns: Array.from({ length: 12 }, (_, i) => ({ turn_n: i + 1, provider: 'exotel', end_signal: 'speech_final', t_final: 120, t_first_phrase: 480, t_first_tts: 700, t_first_sent: 910, t_playback_done: 4200, tools: [{ name: 'check_availability_and_book', start: 100, end: 640, ok: i % 3 !== 0 }], stt_audio_s: 3.4, tts_chars: 180, barge_in: i % 4 === 0, reply_used_cached_audio: false, stt_provider: 'sarvam', tts_provider: 'sarvam', llm_model: 'claude-sonnet-5-5' })) });
  return null;
}

// ── Pages ───────────────────────────────────────────────────────────────────
const click = (re, opts = {}) => async page => { await page.getByRole('button', { name: re }).or(page.getByText(re)).first().click(opts); await settle(page, 2); };
const PAGES = [
  { name: 'login', role: 'out', route: '' },
  { name: 'onboarding', role: 'noBiz', route: '' },
  ...['home', 'calls', 'calendar', 'team', 'try', 'settings/business', 'settings/assistant', 'settings/services', 'settings/phone', 'settings/whatsapp', 'settings/privacy', 'settings/billing']
    .map(r => ({ name: `owner-${r.replace('/', '-')}`, role: 'owner', route: r })),
  { name: 'owner-calendar-list', role: 'owner', route: 'calendar', after: click(/^list$/i) },
  { name: 'owner-calendar-booking', role: 'owner', route: 'calendar', after: async page => { await click(/^list$/i)(page); await page.locator('.agenda-item, .event').first().click(); await settle(page, 2); } },
  { name: 'owner-call-detail', role: 'owner', route: 'calls', after: async page => { await page.locator('.feed li, .feed button, .page table tbody tr').filter({ hasText: /Hello|Booked|Info|Message|wa:|\+91/ }).nth(8).click(); await settle(page, 2); } },
  { name: 'owner-service-editor', role: 'owner', route: 'settings/services', after: click(/\+ Add service/) },
  { name: 'owner-service-edit-row', role: 'owner', route: 'settings/services', after: async page => { await page.getByRole('button', { name: 'Edit' }).first().click(); await settle(page, 2); } },
  { name: 'owner-practitioner-editor', role: 'owner', route: 'team', after: async page => { await page.getByRole('button', { name: /^\+ Add|Add (doctor|dentist|practitioner)/i }).first().click(); await settle(page, 2); } },
  { name: 'owner-practitioner-edit-row', role: 'owner', route: 'team', after: async page => { await page.getByRole('button', { name: 'Edit' }).first().click(); await settle(page, 2); } },
  { name: 'owner-menu-open', role: 'owner', route: 'home', after: async page => { const b = page.locator('[data-shot-menu]'); if (await b.isVisible()) { await b.click(); await settle(page, 2); } } },
  ...['home', 'calls', 'calendar', 'team', 'services', 'try'].map(r => ({ name: `staff-${r}`, role: 'staff', route: r })),
  { name: 'staff-call-detail', role: 'staff', route: 'calls', after: async page => { await page.locator('.feed li, .feed button, .page table tbody tr').filter({ hasText: /Hello|Booked|Info|Message|wa:|\+91/ }).nth(8).click(); await settle(page, 2); } },
  ...['op/businesses', 'op/numbers', 'op/whatsapp', 'op/plans', 'op/integrations', 'home', 'calls', 'calendar', 'team', 'try', 'settings/business', 'settings/assistant', 'settings/services', 'settings/phone', 'settings/whatsapp', 'settings/privacy', 'settings/billing']
    .map(r => ({ name: `operator-${r.replace('/', '-')}`, role: 'operator', route: r })),
  { name: 'operator-call-timeline', role: 'operator', route: 'calls', after: async page => { await page.locator('.feed li, .feed button, .page table tbody tr').filter({ hasText: /Hello|Booked|Info|Message|wa:|\+91/ }).nth(8).click(); await settle(page, 2); } },
].filter(p => p.name.includes(ONLY));

// ── In-page checks ──────────────────────────────────────────────────────────
function inPage() {
  const vw = window.innerWidth;
  const sel = el => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${s}#${e.id}`); break; }
      const c = [...e.classList].slice(0, 2).join('.');
      if (c) s += `.${c}`;
      parts.unshift(s);
    }
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return parts.join(' > ') + (t ? ` “${t}”` : '');
  };
  const scrollers = e => { for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
  const hidden = e => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return true; const r = e.getBoundingClientRect(); if (!r.width && !r.height) return true; return !!e.closest('.sr-only, aside.sidebar:not(.open), [aria-hidden="true"] .sr-only'); };
  const out = { a: null, b: [], c: [], d: [] };
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1) out.a = `scrollWidth ${de.scrollWidth} > ${vw}`;
  for (const e of document.querySelectorAll('body *')) {
    if (hidden(e)) continue;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (r.right > vw + 1 && !scrollers(e) && cs.position !== 'fixed' || (cs.position === 'fixed' && r.right > vw + 1)) out.b.push(`${sel(e)} → right ${Math.round(r.right)}`);
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && e.type !== 'hidden' && (r.height < 40 || (r.width < 40 && e.tagName !== 'INPUT' && !(e.type === 'checkbox' || e.type === 'radio')))) {
      if (e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p, li, span, td, div.small')) continue;
      out.c.push(`${sel(e)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (own.length >= 8 && r.width < 56 && !/\s/.test(own) === false && r.height > 3 * parseFloat(cs.lineHeight || '16')) out.d.push(`${sel(e)} squeezed to ${Math.round(r.width)}px`);
    const ox = cs.overflowX;
    if ((ox === 'hidden' || ox === 'clip') && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && cs.textOverflow !== 'ellipsis' && (e.textContent || '').trim()) {
      // clipped only if some descendant text really crosses the box edge
      const box = e.getBoundingClientRect(); let clipped = false;
      for (const k of e.querySelectorAll('*')) { const kr = k.getBoundingClientRect(); if (kr.width && kr.right > box.right + 1 && k.childNodes.length && [...k.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { clipped = true; break; } }
      if (clipped || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) out.d.push(`${sel(e)} scroll ${e.scrollWidth} > ${e.clientWidth}`);
    }
  }
  return out;
}

// Wait until the page text stops changing (data loaded, effects run).
async function settle(page, need = 5) {
  let last = -1, same = 0;
  for (let i = 0; i < 40 && same < need; i++) {
    await page.waitForTimeout(100);
    const n = await page.evaluate(() => document.body.innerText.length + document.querySelectorAll('*').length).catch(() => -2);
    same = n === last ? same + 1 : 0; last = n;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_BASE)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 250)); if (i === 59) throw new Error('vite preview did not start (run npm run build first)'); }
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = []; // {page,width,theme,a,b,c,d}
  const unmocked = new Set(); const pageErrors = new Set();
  try {
    const combos = WIDTHS.flatMap(width => THEMES.map(theme => ({ width, theme })));
    const runCombo = async ({ width, theme }) => {
      const dir = join(OUT, `${width}-${theme}`); mkdirSync(dir, { recursive: true });
      const phone = width < 600;
      const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 1024 }, deviceScaleFactor: 1, isMobile: false, hasTouch: phone, colorScheme: theme });
      for (const role of ['out', 'noBiz', 'owner', 'staff', 'operator']) {
        const list = PAGES.filter(p => p.role === role); if (!list.length) continue;
        const page = await ctx.newPage(); page.setDefaultTimeout(3000);
        page.on('pageerror', e => pageErrors.add(`${role}: ${e.message.slice(0, 120)}`));
        await page.route('https://mogi-platform.premkumar-2ba.workers.dev/**', async route => {
          const u = new URL(route.request().url());
          const body = api(u.pathname, route.request().method(), role);
          if (!body) { unmocked.add(`${route.request().method()} ${u.pathname}`); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(OK([])) }); }
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.addInitScript(({ role, theme }) => {
          try {
            localStorage.setItem('avery.theme', theme);
            if (role === 'owner' || role === 'staff' || role === 'noBiz') sessionStorage.setItem('avery.ownerToken', 'tok');
            if (role === 'operator') sessionStorage.setItem('mogi.adminKey', 'key');
          } catch { /* ignore */ }
        }, { role, theme });
        for (const p of list) {
          try {
                        await page.goto(`${URL_BASE}/#/${p.route}`, { waitUntil: 'load' });
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForFunction(() => !/Loading…/.test(document.querySelector('main')?.textContent ?? ''), null, { timeout: 1500 }).catch(() => {});
            // pick a business for the operator's business pages
            await settle(page);
            if (p.after) await p.after(page).catch(e => { if (VERBOSE) console.log(`  (${p.name}) action failed: ${e.message.split('\n')[0]}`); results.push({ page: p.name, width, theme, actionFailed: true }); });
            const r = await page.evaluate(inPage);
            results.push({ page: p.name, width, theme, ...r });
            await page.screenshot({ path: join(dir, `${p.name}.png`), fullPage: true });
          } catch (e) { results.push({ page: p.name, width, theme, a: `check crashed: ${e.message.split('\n')[0]}`, b: [], c: [], d: [] }); }
        }
        await page.close();
      }
      await ctx.close();
    };
    const queue = [...combos];
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => { for (let c; (c = queue.shift());) await runCombo(c); }));
  } finally { await browser.close(); server.kill(); }

  // ── Report ──
  const names = [...new Set(results.map(r => r.page))];
  const cell = (n, w) => {
    const rs = results.filter(r => r.page === n && r.width === w); if (!rs.length) return '-';
    const f = [rs.some(r => r.a) && 'a', rs.some(r => r.b?.length) && 'b', rs.some(r => r.d?.length) && 'd'].filter(Boolean);
    return f.length ? `FAIL(${f.join(',')})` : rs.some(r => r.actionFailed) ? 'NOACT' : 'pass';
  };
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('page', 34)}${WIDTHS.map(w => pad(w, 14)).join('')}tap<40px`);
  for (const n of names) console.log(`${pad(n, 34)}${WIDTHS.map(w => pad(cell(n, w), 14)).join('')}${Math.max(0, ...results.filter(r => r.page === n).map(r => r.c?.length ?? 0))}`);
  const bad = results.filter(r => r.a || r.b?.length);
  const warn = results.filter(r => r.d?.length);
  const show = (tag, key) => { for (const r of results.filter(x => (key === 'a' ? x.a : x[key]?.length))) { const items = key === 'a' ? [r.a] : [...new Set(r[key])]; console.log(`${tag} ${r.page} @${r.width}-${r.theme}: ${items.slice(0, 4).join(' | ')}${items.length > 4 ? ` (+${items.length - 4})` : ''}`); } };
  if (bad.length) { console.log('\nOffenders (a: page scroll, b: past right edge)'); show('a', 'a'); show('b', 'b'); }
  if (warn.length) { console.log('\nClipped text (d), not a failure'); show('d', 'd'); }
  if (VERBOSE) { console.log('\nSmall tap targets (c), not a failure'); show('c', 'c'); }
  if (unmocked.size) console.log(`\nUnmocked API paths (returned []): ${[...unmocked].join(', ')}`);
  if (pageErrors.size) console.log(`\nPage errors:\n  ${[...pageErrors].join('\n  ')}`);
  const noact = results.filter(r => r.actionFailed); if (noact.length) console.log(`\nDialog steps that could not run: ${[...new Set(noact.map(r => r.page))].join(', ')}`);
  const checks = names.length * WIDTHS.length;
  console.log(`\n${names.length} pages × ${WIDTHS.length} widths × ${THEMES.length} themes = ${results.filter(r => !r.actionFailed || r.a !== undefined).length} checks; fail (a/b): ${new Set(bad.map(r => `${r.page}@${r.width}`)).size} of ${checks} page×width; screenshots in web/mobile-check/`);
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
