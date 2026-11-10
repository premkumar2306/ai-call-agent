// Per-business voice language and STT/TTS provider settings, plus the
// language-specific text rules the phone pipeline needs (backchannels,
// discourse fillers, dangling words, canned lines, prompt rules).
//
// Everything here is keyed on VoiceLanguage. 'en' is the default and must
// reproduce today's behaviour exactly: English callers keep the original
// word lists, regexes, canned lines and prompt text byte for byte. Hindi
// ('hi') and Hinglish ('hi-en') are opt-in per business (sectors.voice_*,
// migration 0012).

export const VOICE_LANGUAGES = ['en', 'hi', 'hi-en'] as const;
export type VoiceLanguage = typeof VOICE_LANGUAGES[number];
export const STT_PROVIDERS = ['deepgram', 'sarvam'] as const;
export type SttProviderName = typeof STT_PROVIDERS[number];
export const TTS_PROVIDERS = ['cartesia', 'sarvam'] as const;
export type TtsProviderName = typeof TTS_PROVIDERS[number];

export interface VoiceSettings {
  language: VoiceLanguage;
  sttProvider: SttProviderName;
  ttsProvider: TtsProviderName;
  /** Provider voice: a Cartesia voice id or a Sarvam Bulbul speaker. Unset = the provider default. */
  voiceId?: string;
}

export const DEFAULT_VOICE: VoiceSettings = { language: 'en', sttProvider: 'deepgram', ttsProvider: 'cartesia' };

/** Settings from a sector row / cached SectorMeta; anything missing or unknown is the default. */
export function resolveVoiceSettings(meta: { voice?: Partial<VoiceSettings> | null } | null | undefined): VoiceSettings {
  const v = meta?.voice ?? {};
  return {
    language: (VOICE_LANGUAGES as readonly string[]).includes(v.language as string) ? v.language as VoiceLanguage : 'en',
    sttProvider: (STT_PROVIDERS as readonly string[]).includes(v.sttProvider as string) ? v.sttProvider as SttProviderName : 'deepgram',
    ttsProvider: (TTS_PROVIDERS as readonly string[]).includes(v.ttsProvider as string) ? v.ttsProvider as TtsProviderName : 'cartesia',
    ...(typeof v.voiceId === 'string' && v.voiceId ? { voiceId: v.voiceId } : {}),
  };
}

/** True when nothing differs from today's English Deepgram + Cartesia pipeline. */
export function isDefaultVoice(v: VoiceSettings): boolean {
  return v.language === 'en' && v.sttProvider === 'deepgram' && v.ttsProvider === 'cartesia' && !v.voiceId;
}

/** Whether the STT side (language or provider) differs from the default — i.e. the STT socket must be reopened. */
export function sttDiffers(v: VoiceSettings): boolean {
  return v.language !== 'en' || v.sttProvider !== 'deepgram';
}

export function usesSarvam(v: VoiceSettings): boolean {
  return v.sttProvider === 'sarvam' || v.ttsProvider === 'sarvam';
}

const VOICE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * Validates the voice fields of an admin request (snake_case, as POSTed).
 * Returns only the fields that were given, or an error message. `hasSarvamKey`
 * makes selecting Sarvam fail closed when SARVAM_API_KEY isn't configured.
 */
export function parseVoiceInput(
  body: Record<string, unknown>,
  current: VoiceSettings,
  hasSarvamKey: boolean,
): { ok: true; value: Partial<VoiceSettings> } | { ok: false; error: string } {
  const out: Partial<VoiceSettings> = {};
  if (body.voice_language !== undefined) {
    if (!(VOICE_LANGUAGES as readonly unknown[]).includes(body.voice_language)) return { ok: false, error: `voice_language must be one of ${VOICE_LANGUAGES.join(', ')}` };
    out.language = body.voice_language as VoiceLanguage;
  }
  if (body.stt_provider !== undefined) {
    if (!(STT_PROVIDERS as readonly unknown[]).includes(body.stt_provider)) return { ok: false, error: `stt_provider must be one of ${STT_PROVIDERS.join(', ')}` };
    out.sttProvider = body.stt_provider as SttProviderName;
  }
  if (body.tts_provider !== undefined) {
    if (!(TTS_PROVIDERS as readonly unknown[]).includes(body.tts_provider)) return { ok: false, error: `tts_provider must be one of ${TTS_PROVIDERS.join(', ')}` };
    out.ttsProvider = body.tts_provider as TtsProviderName;
  }
  if (body.voice_id !== undefined) {
    if (body.voice_id === null || body.voice_id === '') out.voiceId = undefined;
    else if (typeof body.voice_id !== 'string' || !VOICE_ID_RE.test(body.voice_id.trim())) return { ok: false, error: 'voice_id must be a provider voice id (letters, digits, _ . : -)' };
    else out.voiceId = body.voice_id.trim();
  }
  const merged = { ...current, ...out };
  if ('voiceId' in out && out.voiceId === undefined) delete merged.voiceId;
  if (usesSarvam(merged) && !hasSarvamKey) {
    return { ok: false, error: 'Sarvam needs the SARVAM_API_KEY secret (wrangler secret put SARVAM_API_KEY)' };
  }
  // Cartesia's default voice is English; a Hindi reply needs a Hindi-native voice.
  if (merged.ttsProvider === 'cartesia' && merged.language !== 'en' && !merged.voiceId) {
    return { ok: false, error: 'Hindi on Cartesia needs voice_id: a Hindi-native Cartesia voice id' };
  }
  return { ok: true, value: out };
}

// ── Text normalisation ──────────────────────────────────────────────────────

/**
 * Lowercased words with punctuation stripped. For non-English languages the
 * Unicode letters and combining marks are kept — the English-only
 * `[^a-z]` filter turns Devanagari ("हाँ") into nothing.
 */
export function wordsOf(text: string, lang: VoiceLanguage): string[] {
  const t = text.toLowerCase();
  if (lang === 'en') return t.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return t.replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Sentence-final punctuation, including the Devanagari danda (।, ॥) for Hindi. */
export function endsSentence(text: string, lang: VoiceLanguage, marks = '.?!'): boolean {
  const set = lang === 'en' ? marks : `${marks}।॥`;
  // Same test as the original English-only /[.?!]["')]?$/ (no trimming).
  return new RegExp(`[${set.replace(/[\]\\^-]/g, '\\$&')}]["')]?$`).test(text);
}

// Hindi / Hinglish listener feedback, in Devanagari and the common romanised
// spellings STT produces. "नहीं"/"nahi" is deliberately absent: it's an answer.
export const HINDI_BACKCHANNEL_WORDS = new Set([
  'हाँ', 'हां', 'हा', 'हाँजी', 'हांजी', 'जी', 'अच्छा', 'ठीक', 'है', 'हम्म', 'हम', 'हूँ', 'हूं', 'ओके', 'सही', 'बिल्कुल', 'बिलकुल', 'अरे',
  'haan', 'han', 'haa', 'ha', 'haanji', 'hanji', 'ji', 'jee', 'achha', 'acha', 'accha', 'achchha', 'theek', 'thik', 'hai', 'he',
  'hmm', 'hm', 'hmmm', 'sahi', 'bilkul', 'arey',
]);

// Floor-holders that start a Hindi sentence ("तो…", "मतलब…", "देखिए…").
export const HINDI_DISCOURSE_WORDS = new Set([
  'तो', 'मतलब', 'वो', 'वह', 'और', 'लेकिन', 'पर', 'अम्म', 'उम्म', 'देखिए', 'सुनिए', 'असल', 'में', 'यानी',
  'toh', 'to', 'matlab', 'woh', 'wo', 'vo', 'aur', 'lekin', 'par', 'umm', 'dekhiye', 'suniye', 'yaani',
]);

// Words a Hindi sentence doesn't end on: conjunctions, postpositions,
// possessives. Hindi is verb-final, so these mean the caller paused mid-thought.
export const HINDI_DANGLING_WORDS = new Set([
  'और', 'या', 'लेकिन', 'कि', 'के', 'का', 'की', 'को', 'में', 'से', 'पर', 'मेरा', 'मेरी', 'मेरे', 'हमारा', 'हमारी', 'तो', 'क्योंकि', 'अगर', 'जो', 'वाला', 'वाली',
  'aur', 'lekin', 'ki', 'ke', 'ka', 'ko', 'mein', 'se', 'mera', 'meri', 'mere', 'hamara', 'hamari', 'toh', 'kyunki', 'kyonki', 'agar', 'jo', 'wala', 'wali',
]);

// ── Canned lines ────────────────────────────────────────────────────────────

export interface VoiceLines {
  opener: string;
  fillers: string[];
  stillWorking: string[];
  stillThere: string;
  goodbye: (bizName?: string) => string;
  greeting: (storeName: string, capabilityHint: string) => string;
  customGreeting: (greeting: string, agentName: string) => string;
  capabilityHint: (businessType: string | undefined) => string;
}

// The English lines are the ones CallRelay has always spoken — don't reword them.
const EN_LINES: VoiceLines = {
  opener: 'Thanks for calling!',
  fillers: ['One moment.', 'Let me check.', 'Just a second.'],
  stillWorking: ['Still checking, thanks for waiting.', 'Almost there.'],
  stillThere: 'Are you still there?',
  goodbye: (name) => `I haven't heard anything, so I'll hang up now. Thanks for calling${name ? ` ${name}` : ''}. Goodbye!`,
  greeting: (store, hint) => `You've reached ${store}. I'm Mogi, the virtual assistant. ${hint}`,
  customGreeting: (g, agent) => `${g} I'm ${agent || 'Mogi'}, the virtual assistant.`,
  capabilityHint: (bt) => bt === 'health_nav'
    ? "I can check your coverage, answer benefits questions, or help you find care — what's going on?"
    : 'I can answer questions about our services and prices, or book you in — what can I do for you?',
};

// Hindi in Devanagari (both Sarvam Bulbul and Cartesia read Devanagari as
// Hindi), with "हम" (we, the business) so no line needs a gendered verb form
// that might not match the chosen voice.
const HI_LINES: VoiceLines = {
  opener: 'नमस्ते! कॉल करने के लिए धन्यवाद।',
  fillers: ['एक पल।', 'जी, देख रहे हैं।', 'बस एक सेकंड।'],
  stillWorking: ['अभी देख रहे हैं, थोड़ा रुकिए।', 'बस हो गया।'],
  stillThere: 'क्या आप लाइन पर हैं?',
  goodbye: (name) => `कोई आवाज़ नहीं आ रही है, इसलिए हम कॉल रख रहे हैं। ${name ? `${name} को ` : ''}कॉल करने के लिए धन्यवाद। नमस्ते!`,
  greeting: (store, hint) => `${store} में आपका स्वागत है। मैं Mogi हूँ, वर्चुअल असिस्टेंट। ${hint}`,
  customGreeting: (g, agent) => `${g} मैं ${agent || 'Mogi'} हूँ, वर्चुअल असिस्टेंट।`,
  capabilityHint: () => 'हम सर्विस और दाम के बारे में बता सकते हैं, या आपकी बुकिंग कर सकते हैं — बताइए, क्या मदद करें?',
};

export function voiceLines(lang: VoiceLanguage): VoiceLines {
  return lang === 'en' ? EN_LINES : HI_LINES;
}

// ── Prompt rules ────────────────────────────────────────────────────────────

/**
 * Extra system-prompt section for a non-English voice line. Empty for 'en',
 * so the English prompt (and its prompt-cache prefix) is unchanged.
 */
export function languageRules(lang: VoiceLanguage): string {
  if (lang === 'en') return '';
  const lead = lang === 'hi'
    ? '- Callers here mostly speak Hindi. Reply in Hindi unless the caller speaks English — then reply in English.'
    : '- Callers here mix Hindi and English (Hinglish). Reply in the language the caller is using right now: Hinglish if they mix, English if they speak English, Hindi if they speak Hindi. Switch when they switch.';
  return `LANGUAGE (Hindi / Hinglish phone line):
${lead}
- Speak naturally, like a polite front-desk person in India: "जी", "आप", "बताइए". Mixing in the English words people actually use is good ("appointment", "service", "booking", "Sunday").
- Write every Hindi word in Devanagari (मैं, आपका, कल) — never romanised Hindi ("main", "aapka"). English words, brand and service names stay in English letters. The voice reads Devanagari as Hindi and English letters as English.
- End Hindi sentences with "।" or "?" — never leave a sentence without its full stop.
- Numbers: write prices, times and phone numbers as digits so they are read correctly — "₹1,500", "4:30 बजे", "सुबह 10 बजे", "98450 12345". Put commas in numbers of five or more digits ("₹12,000"). Dates as "सोमवार, 12 नवंबर". Never spell a number out in romanised Hindi.
- Tool results and the business profile are in English — translate what you say from them; keep service names as they are.
- Refer to yourself and the business as "हम" ("हम देख रहे हैं", "हम बुक कर देते हैं") so no sentence needs a gendered verb form.`;
}
