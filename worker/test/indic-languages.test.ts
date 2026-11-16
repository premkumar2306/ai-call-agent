import { describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import {
  DEFAULT_VOICE, chatLanguageRules, endsSentence, languageRules, parseVoiceInput, resolveVoiceSettings, voiceLines,
} from '../src/services/voice-language';
import { sarvamSttLanguage } from '../src/durable-objects/stt-sarvam';
import { sarvamTtsLanguage } from '../src/durable-objects/tts-sarvam';
import { isBackchannel, isDiscourseOnly, looksIncomplete } from '../src/durable-objects/stt-deepgram';
import { DEFAULT_DISCLOSURE_TEXTS, noticeLanguage } from '../src/services/disclosure';
import { cannedReply, templateLanguage } from '../src/services/whatsapp-api';
import { DEFAULT_TEMPLATES, variantName, validateTemplateBody, paramCount } from '../src/services/whatsapp-templates';
import { formatWhen, monthsText, previews } from '../src/services/whatsapp-outbound';
import { voiceNoteQuery } from '../src/routes/whatsapp';
import { DRAVIDIAN, LANGUAGE_NAMES, LINES, BACKCHANNEL, DISCOURSE, DANGLING, DISCLOSURE, WHATSAPP_NOTICE, CANNED, TEMPLATE_BODIES, DATE_WORDS } from '../src/services/indic-languages';

const SCRIPT: Record<string, RegExp> = { kn: /[ಀ-೿]/, te: /[ఀ-౿]/, ta: /[஀-௿]/ };

describe('Kannada, Telugu, Tamil voice settings', () => {
  it('need Sarvam for both directions; the Sarvam codes are kn-IN, te-IN, ta-IN', () => {
    for (const lang of DRAVIDIAN) {
      expect(parseVoiceInput({ voice_language: lang }, DEFAULT_VOICE, true)).toMatchObject({ ok: false });
      expect(parseVoiceInput({ voice_language: lang, stt_provider: 'sarvam', tts_provider: 'cartesia' }, DEFAULT_VOICE, true)).toMatchObject({ ok: false });
      expect(parseVoiceInput({ voice_language: lang, stt_provider: 'sarvam', tts_provider: 'sarvam' }, DEFAULT_VOICE, false)).toMatchObject({ ok: false });
      expect(parseVoiceInput({ voice_language: lang, stt_provider: 'sarvam', tts_provider: 'sarvam' }, DEFAULT_VOICE, true)).toMatchObject({ ok: true });
      expect(sarvamSttLanguage(lang)).toEqual({ languageCode: `${lang}-IN`, mode: 'transcribe' });
      expect(sarvamTtsLanguage(lang)).toBe(`${lang}-IN`);
      expect(resolveVoiceSettings({ voice: { language: lang, sttProvider: 'sarvam', ttsProvider: 'sarvam' } }).language).toBe(lang);
    }
    // English and Hindi are unchanged.
    expect(sarvamTtsLanguage('hi')).toBe('hi-IN');
    expect(sarvamSttLanguage('en')).toEqual({ languageCode: 'en-IN', mode: 'transcribe' });
    expect(languageRules('en')).toBe('');
  });

  it('greeting, lines and DPDP disclosure are in the native script', () => {
    for (const lang of DRAVIDIAN) {
      const L = voiceLines(lang);
      const g = L.greeting('Smile Dental', L.capabilityHint('in_x', 'clinic'), 'Avery');
      expect(g).toMatch(SCRIPT[lang]);
      expect(g).toContain('Smile Dental');
      expect(g).toContain('Avery');
      for (const t of [L.opener, L.stillThere, L.goodbye('Smile Dental'), ...L.fillers, ...L.stillWorking]) expect(t).toMatch(SCRIPT[lang]);
      expect(noticeLanguage({ voice: { language: lang } })).toBe(lang);
      expect(DEFAULT_DISCLOSURE_TEXTS[lang]).toMatch(SCRIPT[lang]);
      expect(DEFAULT_DISCLOSURE_TEXTS[lang]).toContain('AI');
      expect(DEFAULT_DISCLOSURE_TEXTS[lang].length).toBeLessThanOrEqual(400);
    }
  });

  it('prompt rules: reply in the language, native script, numbers as digits', () => {
    for (const lang of DRAVIDIAN) {
      const r = languageRules(lang);
      expect(r).toContain(`${LANGUAGE_NAMES[lang].english} phone line`);
      expect(r).toMatch(/digits/);
      expect(r).toContain('₹1,500');
      expect(r).toContain(LANGUAGE_NAMES[lang].we);
      expect(chatLanguageRules(lang)).toContain(LANGUAGE_NAMES[lang].english);
    }
  });

  it('turn-taking: backchannels, floor-holders and dangling words', () => {
    expect(isBackchannel('ಹೌದು ಸರಿ', 'kn')).toBe(true);
    expect(isBackchannel('సరే', 'te')).toBe(true);
    expect(isBackchannel('சரி சரி', 'ta')).toBe(true);
    expect(isBackchannel('ನನಗೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬೇಕು', 'kn')).toBe(false);
    expect(isDiscourseOnly('అంటే', 'te')).toBe(true);
    expect(looksIncomplete('எனக்கு ஒரு அப்பாயிண்ட்மென்ட் மற்றும்', 'ta')).toBe(true);
    expect(endsSentence('ಸರಿ.', 'kn')).toBe(true);
  });
});

describe('Kannada, Telugu, Tamil on WhatsApp', () => {
  it('templates: every family in kn/te/ta passes Meta structural rules with the same parameters', () => {
    for (const t of DEFAULT_TEMPLATES) for (const lang of DRAVIDIAN) {
      expect(validateTemplateBody(t.body[lang]), `${t.family}/${lang}`).toBeNull();
      expect(paramCount(t.body[lang])).toBe(t.example.length);
      expect(t.body[lang]).toMatch(SCRIPT[lang]);
      expect(variantName(t.family, lang)).toEqual({ name: t.family, language: lang });
    }
  });
  it('dates, times and "N months" read naturally; canned replies; template language', () => {
    for (const lang of DRAVIDIAN) {
      expect(formatWhen('2026-11-18T10:30', lang, '2026-11-17')).toBe(`${DATE_WORDS[lang].tomorrow}, ${new Intl.DateTimeFormat(`${lang}-IN`, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date('2026-11-18T10:30:00Z'))}`);
      expect(formatWhen('2026-11-20T10:30', lang)).toMatch(/20/);
      expect(monthsText(6, lang)).toMatch(/^6 /);
      expect(cannedReply('optedOut', lang)).toContain('START');
      expect(cannedReply('optedIn', lang)).toContain('STOP');
      expect(templateLanguage({} as any, lang)).toBe(lang);
      expect(previews({ voice: { language: lang } } as any, 'Smile Dental').reminder).toMatch(SCRIPT[lang]);
    }
    expect(voiceNoteQuery('kn')).toContain('detect_language=true');
    expect(voiceNoteQuery('hi')).toContain('language=hi');
  });
});

// docs/translations-review.md is generated from indic-languages.ts, so the
// file the owner hands to reviewers always matches what ships.
// Regenerate: UPDATE_TRANSLATIONS=1 npx vitest run test/indic-languages.test.ts
describe('translations review file', () => {
  it('is up to date', () => {
    const path = new URL('../../docs/translations-review.md', import.meta.url).pathname;
    const md = buildReviewDoc();
    if (process.env.UPDATE_TRANSLATIONS) writeFileSync(path, md);
    expect(readFileSync(path, 'utf8')).toBe(md);
  });
});

function buildReviewDoc(): string {
  const out: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  out.push('# Translations to review: Kannada, Telugu, Tamil',
    '',
    '**Status: NEEDS REVIEW BY A NATIVE SPEAKER.** Every string below was written without one. Please check meaning, politeness',
    '(a clinic front desk speaking to patients), natural word choice, and that nothing sounds machine-translated.',
    'Mark corrections in the "Reviewer notes" column, or edit `worker/src/services/indic-languages.ts` directly.',
    '',
    'Generated from `worker/src/services/indic-languages.ts` (do not edit by hand; run',
    '`UPDATE_TRANSLATIONS=1 npx vitest run test/indic-languages.test.ts` in `worker/` after changing a string).',
    '',
    'Placeholders: `{{1}}`, `{{2}}`, `{{3}}` are filled in by the system (business name, service, date/time, link). Keep them,',
    'in the same order. `STOP`, `START` and `CALL` are keywords patients type: keep them in English letters.',
    '"we" is used for the clinic throughout, to avoid gendered verb forms.',
    '');
  const section = (title: string, rows: Array<[string, Record<string, string>]>, note?: string) => {
    out.push(`## ${title}`, '');
    if (note) out.push(note, '');
    for (const lang of DRAVIDIAN) {
      out.push(`### ${LANGUAGE_NAMES[lang].english} (${LANGUAGE_NAMES[lang].native})`, '', '| Key | English meaning | Text | Reviewer notes |', '|---|---|---|---|');
      for (const [key, by] of rows) out.push(`| ${key} | ${cell(by.en ?? '')} | ${cell(by[lang])} | |`);
      out.push('');
    }
  };
  const L = (f: (l: (typeof LINES)['kn']) => string) => Object.fromEntries(DRAVIDIAN.map(l => [l, f(LINES[l])]));
  section('Phone calls: what the assistant says', [
    ['opener', { en: 'Thanks for calling!', ...L(x => x.opener) }],
    ['greeting', { en: "You've reached {business}. I'm {assistant}, the virtual assistant. {hint}", ...L(x => x.greeting('{business}', '{hint}', '{assistant}')) }],
    ['greeting (owner wrote their own)', { en: "{owner's greeting} I'm {assistant}, the virtual assistant.", ...L(x => x.customGreeting("{owner's greeting}", '{assistant}')) }],
    ['hint', { en: 'I can answer questions about our services and prices, or book you in — what can I do for you?', ...L(x => x.hint) }],
    ['hint (law firm)', { en: 'I can tell you about our consultations and fees, or book a consultation with one of our lawyers.', ...L(x => x.hintLegal) }],
    ...[0, 1, 2].map(i => [`filler ${i + 1}`, { en: ['One moment.', 'Let me check.', 'Just a second.'][i], ...L(x => x.fillers[i]) }] as [string, Record<string, string>]),
    ...[0, 1].map(i => [`still working ${i + 1}`, { en: ['Still checking, thanks for waiting.', 'Almost there.'][i], ...L(x => x.stillWorking[i]) }] as [string, Record<string, string>]),
    ['still there?', { en: 'Are you still there?', ...L(x => x.stillThere) }],
    ['goodbye (silence)', { en: "I haven't heard anything, so I'll hang up now. Thanks for calling {business}. Goodbye!", ...L(x => x.goodbye('{business}')) }],
  ]);
  section('DPDP notice (spoken at the start of every call, and on WhatsApp)', [
    ['call notice', { en: DEFAULT_DISCLOSURE_TEXTS.en, ...DISCLOSURE }],
    ['WhatsApp notice', { en: "You're chatting with an AI assistant. Messages are stored so we can help you.", ...WHATSAPP_NOTICE }],
  ], 'Legal meaning must be exact: the patient is told they are talking to an AI and that the call is transcribed.');
  section('WhatsApp templates (submitted to Meta for approval)', Object.entries(TEMPLATE_BODIES).map(([event, by]) => {
    const t = DEFAULT_TEMPLATES.find(d => d.event === event)!;
    return [`${t.family} (${event})`, { ...by, en: t.body.en }];
  }));
  section('WhatsApp automatic replies', Object.entries(CANNED).map(([k, by]) => [k, { ...by, en: cannedReply(k as any, 'en') }]));
  section('Dates and small words', [
    ['today', { en: 'today', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DATE_WORDS[l].today])) }],
    ['tomorrow', { en: 'tomorrow', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DATE_WORDS[l].tomorrow])) }],
    ['sample service (previews)', { en: 'Consultation', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DATE_WORDS[l].sample])) }],
    ['6 months', { en: '6 months', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DATE_WORDS[l].months(6)])) }],
  ], 'Weekday and month names come from the browser/Intl locale data (kn-IN, te-IN, ta-IN), not from this list.');
  section('Turn-taking word lists (speech recognition)', [
    ['backchannels (listener feedback: "yes", "ok")', { en: 'yes, ok, hmm', ...Object.fromEntries(DRAVIDIAN.map(l => [l, BACKCHANNEL[l].join(', ')])) }],
    ['floor-holders ("so", "I mean")', { en: 'so, I mean, but', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DISCOURSE[l].join(', ')])) }],
    ['words a sentence does not end on', { en: 'and, or, but, my, our, because', ...Object.fromEntries(DRAVIDIAN.map(l => [l, DANGLING[l].join(', ')])) }],
  ], 'Please add common words (and the romanised spellings speech recognition produces) that are missing.');
  return out.join('\n') + '\n';
}
