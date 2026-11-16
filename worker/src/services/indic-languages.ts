// Kannada, Telugu and Tamil (launch item 5): every string Avery says or sends
// in these languages lives here, so docs/translations-review.md can be
// generated from one place (test/translations-doc.test.ts).
//
// NEEDS REVIEW BY A NATIVE SPEAKER: all of it was written without one.
// The phone line for these languages always uses Sarvam for speech in and
// out (kn-IN, te-IN, ta-IN).

export const DRAVIDIAN = ['kn', 'te', 'ta'] as const;
export type DravidianLang = typeof DRAVIDIAN[number];
export const isDravidian = (x: unknown): x is DravidianLang => typeof x === 'string' && (DRAVIDIAN as readonly string[]).includes(x);

export const LANGUAGE_NAMES: Record<DravidianLang, { english: string; native: string; bcp47: string; region: string; we: string; script: string }> = {
  kn: { english: 'Kannada', native: 'ಕನ್ನಡ', bcp47: 'kn-IN', region: 'Karnataka', we: 'ನಾವು', script: 'Kannada script (ನಮಸ್ಕಾರ, ನಿಮ್ಮ, ನಾಳೆ)' },
  te: { english: 'Telugu', native: 'తెలుగు', bcp47: 'te-IN', region: 'Andhra Pradesh and Telangana', we: 'మేము', script: 'Telugu script (నమస్కారం, మీ, రేపు)' },
  ta: { english: 'Tamil', native: 'தமிழ்', bcp47: 'ta-IN', region: 'Tamil Nadu', we: 'நாங்கள்', script: 'Tamil script (வணக்கம், உங்கள், நாளை)' },
};

// ── Phone lines (CallRelay) ─────────────────────────────────────────────────

export interface IndicLines {
  opener: string; fillers: string[]; stillWorking: string[]; stillThere: string;
  goodbye: (name?: string) => string;
  greeting: (store: string, hint: string, agent: string) => string;
  customGreeting: (g: string, agent: string) => string;
  hint: string; hintLegal: string;
}

export const LINES: Record<DravidianLang, IndicLines> = {
  kn: {
    opener: 'ನಮಸ್ಕಾರ! ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು.',
    fillers: ['ಒಂದು ಕ್ಷಣ.', 'ನೋಡುತ್ತಿದ್ದೇವೆ.', 'ಒಂದು ಸೆಕೆಂಡ್.'],
    stillWorking: ['ಇನ್ನೂ ನೋಡುತ್ತಿದ್ದೇವೆ, ದಯವಿಟ್ಟು ಕಾಯಿರಿ.', 'ಬಹುತೇಕ ಆಯಿತು.'],
    stillThere: 'ನೀವು ಲೈನ್‌ನಲ್ಲಿ ಇದ್ದೀರಾ?',
    goodbye: (name) => `ಏನೂ ಕೇಳಿಸುತ್ತಿಲ್ಲ, ಆದ್ದರಿಂದ ಕರೆ ಮುಗಿಸುತ್ತಿದ್ದೇವೆ. ${name ? `${name} ಗೆ ` : ''}ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಮಸ್ಕಾರ!`,
    greeting: (store, hint, agent) => `${store} ಗೆ ಸ್ವಾಗತ. ನಾನು ${agent}, ವರ್ಚುವಲ್ ಅಸಿಸ್ಟೆಂಟ್. ${hint}`,
    customGreeting: (g, agent) => `${g} ನಾನು ${agent}, ವರ್ಚುವಲ್ ಅಸಿಸ್ಟೆಂಟ್.`,
    hint: 'ನಮ್ಮ ಸೇವೆಗಳು ಮತ್ತು ದರಗಳ ಬಗ್ಗೆ ಹೇಳಬಹುದು, ಅಥವಾ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಬಹುದು — ಹೇಳಿ, ಏನು ಸಹಾಯ ಮಾಡಲಿ?',
    hintLegal: 'ಕನ್ಸಲ್ಟೇಶನ್ ಮತ್ತು ಶುಲ್ಕದ ಬಗ್ಗೆ ಹೇಳಬಹುದು, ಅಥವಾ ವಕೀಲರ ಜೊತೆ ಕನ್ಸಲ್ಟೇಶನ್ ಬುಕ್ ಮಾಡಬಹುದು — ಹೇಳಿ, ಏನು ಸಹಾಯ ಮಾಡಲಿ?',
  },
  te: {
    opener: 'నమస్కారం! కాల్ చేసినందుకు ధన్యవాదాలు.',
    fillers: ['ఒక్క క్షణం.', 'చూస్తున్నాం.', 'ఒక్క సెకను.'],
    stillWorking: ['ఇంకా చూస్తున్నాం, దయచేసి వేచి ఉండండి.', 'దాదాపు అయిపోయింది.'],
    stillThere: 'మీరు లైన్‌లో ఉన్నారా?',
    goodbye: (name) => `ఏమీ వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాం. ${name ? `${name} కి ` : ''}కాల్ చేసినందుకు ధన్యవాదాలు. నమస్కారం!`,
    greeting: (store, hint, agent) => `${store} కి స్వాగతం. నేను ${agent}, వర్చువల్ అసిస్టెంట్. ${hint}`,
    customGreeting: (g, agent) => `${g} నేను ${agent}, వర్చువల్ అసిస్టెంట్.`,
    hint: 'మా సేవలు, ధరల గురించి చెప్పగలం, లేదా మీ అపాయింట్‌మెంట్ బుక్ చేయగలం — చెప్పండి, ఏం సహాయం చేయాలి?',
    hintLegal: 'కన్సల్టేషన్, ఫీజుల గురించి చెప్పగలం, లేదా లాయర్‌తో కన్సల్టేషన్ బుక్ చేయగలం — చెప్పండి, ఏం సహాయం చేయాలి?',
  },
  ta: {
    opener: 'வணக்கம்! அழைத்ததற்கு நன்றி.',
    fillers: ['ஒரு நிமிடம்.', 'பார்க்கிறோம்.', 'ஒரு நொடி.'],
    stillWorking: ['இன்னும் பார்க்கிறோம், கொஞ்சம் காத்திருங்கள்.', 'கிட்டத்தட்ட முடிந்தது.'],
    stillThere: 'நீங்கள் லைனில் இருக்கிறீர்களா?',
    goodbye: (name) => `எதுவும் கேட்கவில்லை, அதனால் அழைப்பை முடிக்கிறோம். ${name ? `${name} ` : ''}அழைத்ததற்கு நன்றி. வணக்கம்!`,
    greeting: (store, hint, agent) => `${store} க்கு வரவேற்கிறோம். நான் ${agent}, வர்ச்சுவல் அசிஸ்டன்ட். ${hint}`,
    customGreeting: (g, agent) => `${g} நான் ${agent}, வர்ச்சுவல் அசிஸ்டன்ட்.`,
    hint: 'எங்கள் சேவைகள், கட்டணங்கள் பற்றி சொல்லலாம், அல்லது உங்கள் அப்பாயிண்ட்மென்ட்டை புக் செய்யலாம் — சொல்லுங்கள், என்ன உதவி வேண்டும்?',
    hintLegal: 'கன்சல்டேஷன், கட்டணம் பற்றி சொல்லலாம், அல்லது வழக்கறிஞருடன் கன்சல்டேஷன் புக் செய்யலாம் — சொல்லுங்கள், என்ன உதவி வேண்டும்?',
  },
};

// Listener feedback, floor-holders and words a sentence doesn't end on
// (turn-taking heuristics; native script plus common romanised STT output).
export const BACKCHANNEL: Record<DravidianLang, string[]> = {
  kn: ['ಹೌದು', 'ಹೂಂ', 'ಹೂ', 'ಸರಿ', 'ಓಕೆ', 'ಆಯ್ತು', 'ಹಾ', 'ಹ್ಮ್', 'ಹಾಂ', 'houdu', 'sari', 'aytu', 'hoon', 'hu'],
  te: ['అవును', 'ఆ', 'సరే', 'ఓకే', 'హా', 'హ్మ్', 'ఊ', 'అలాగే', 'avunu', 'sare', 'haa', 'alage'],
  ta: ['ஆமா', 'ஆமாம்', 'சரி', 'ஓகே', 'ம்', 'ம்ம்', 'ஹா', 'சரிங்க', 'aama', 'aamaa', 'sari', 'seri'],
};
export const DISCOURSE: Record<DravidianLang, string[]> = {
  kn: ['ಅಂದ್ರೆ', 'ಮತ್ತೆ', 'ಆದರೆ', 'ಅದು', 'ಅಂದರೆ', 'ನೋಡಿ'],
  te: ['అంటే', 'మరి', 'కానీ', 'అది', 'చూడండి'],
  ta: ['அதாவது', 'அப்புறம்', 'ஆனா', 'அது', 'பாருங்க'],
};
export const DANGLING: Record<DravidianLang, string[]> = {
  kn: ['ಮತ್ತು', 'ಅಥವಾ', 'ಆದರೆ', 'ನನ್ನ', 'ನಮ್ಮ', 'ಯಾಕೆಂದರೆ'],
  te: ['మరియు', 'లేదా', 'కానీ', 'నా', 'మా', 'ఎందుకంటే'],
  ta: ['மற்றும்', 'அல்லது', 'ஆனா', 'என்', 'எங்கள்', 'ஏனென்றால்'],
};

/** Phone-line prompt rules (system prompt; English instructions to the model). */
export function phoneRules(lang: DravidianLang): string {
  const L = LANGUAGE_NAMES[lang];
  return `LANGUAGE (${L.english} phone line):
- Callers here mostly speak ${L.english}. Reply in ${L.english} unless the caller speaks English — then reply in English. Switch when they switch.
- Speak naturally, like a polite front-desk person in ${L.region}. Mixing in the English words people actually use is good ("appointment", "booking", "doctor", "cleaning").
- Write every ${L.english} word in ${L.script} — never romanised. English words, brand and service names stay in English letters. The voice reads ${L.english} script as ${L.english} and English letters as English.
- End every sentence with "." or "?".
- Numbers: write prices, times, dates and phone numbers as digits so the voice says them naturally in ${L.english} — "₹1,500", "4:30", "10 AM", "12 November", "98450 12345". Never spell a number out in romanised ${L.english}.
- Tool results and the business profile are in English — translate what you say from them; keep service names as they are.
- Refer to yourself and the business as "${L.we}" (we) so no sentence needs a gendered form.`;
}

/** WhatsApp / web chat rules. */
export function chatRules(lang: DravidianLang): string {
  const L = LANGUAGE_NAMES[lang];
  return `LANGUAGE (${L.english} business):
- Customers here mostly write ${L.english}. Reply in ${L.english}, in ${L.script}, unless the customer writes in English (or romanised ${L.english}) — then reply the way they write.
- Be polite, like a front-desk person in ${L.region}. English words people actually use are fine ("appointment", "booking").
- Prices, times and phone numbers as digits ("₹1,500", "4:30").
- Tool results and the business profile are in English — translate what you say from them; keep service names as they are.`;
}

// ── DPDP disclosure ─────────────────────────────────────────────────────────

export const DISCLOSURE: Record<DravidianLang, string> = {
  kn: 'ನಿಮ್ಮ ಮಾಹಿತಿಗಾಗಿ, ನೀವು AI ಸಹಾಯಕರ ಜೊತೆ ಮಾತನಾಡುತ್ತಿದ್ದೀರಿ, ಮತ್ತು ನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ಈ ಕರೆಯನ್ನು ಬರಹದಲ್ಲಿ ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ. ' +
    'ನಾವು ಕಳುಹಿಸುವ ಪ್ರತಿ ಸಂದೇಶದಲ್ಲಿ ನಮ್ಮ ಗೌಪ್ಯತಾ ಸೂಚನೆಯ ಲಿಂಕ್ ಇದೆ.',
  te: 'మీ సమాచారం కోసం, మీరు AI సహాయకుడితో మాట్లాడుతున్నారు, మీకు సహాయం చేయడానికి ఈ కాల్‌ను రాతపూర్వకంగా నమోదు చేస్తున్నాం. ' +
    'మేము పంపే ప్రతి మెసేజ్‌లో మా గోప్యతా నోటీసు లింక్ ఉంటుంది.',
  ta: 'உங்கள் தகவலுக்கு, நீங்கள் ஒரு AI உதவியாளருடன் பேசுகிறீர்கள், உங்களுக்கு உதவ இந்த அழைப்பு எழுத்து வடிவில் பதிவு செய்யப்படுகிறது. ' +
    'நாங்கள் அனுப்பும் ஒவ்வொரு செய்தியிலும் எங்கள் தனியுரிமை அறிவிப்பின் இணைப்பு உள்ளது.',
};

export const WHATSAPP_NOTICE: Record<DravidianLang, string> = {
  kn: 'ನೀವು AI ಸಹಾಯಕರ ಜೊತೆ ಚಾಟ್ ಮಾಡುತ್ತಿದ್ದೀರಿ. ನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ಸಂದೇಶಗಳನ್ನು ಉಳಿಸಲಾಗುತ್ತದೆ.',
  te: 'మీరు AI సహాయకుడితో చాట్ చేస్తున్నారు. మీకు సహాయం చేయడానికి మెసేజ్‌లు సేవ్ చేయబడతాయి.',
  ta: 'நீங்கள் ஒரு AI உதவியாளருடன் உரையாடுகிறீர்கள். உங்களுக்கு உதவ செய்திகள் சேமிக்கப்படுகின்றன.',
};

// ── WhatsApp ────────────────────────────────────────────────────────────────

export const CANNED: Record<'unsupported' | 'media' | 'voiceFailed' | 'rateLimited' | 'optedOut' | 'optedIn' | 'error', Record<DravidianLang, string>> = {
  unsupported: {
    kn: 'ಕ್ಷಮಿಸಿ, ಈ ರೀತಿಯ ಸಂದೇಶವನ್ನು ತೆರೆಯಲು ಆಗುವುದಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ, ಅಥವಾ ವಾಯ್ಸ್ ನೋಟ್ ಕಳುಹಿಸಿ.',
    te: 'క్షమించండి, ఈ రకమైన మెసేజ్‌ను తెరవలేము. దయచేసి మీ ప్రశ్నను టైప్ చేయండి, లేదా వాయిస్ నోట్ పంపండి.',
    ta: 'மன்னிக்கவும், இந்த வகை செய்தியைத் திறக்க முடியவில்லை. உங்கள் கேள்வியை டைப் செய்யுங்கள், அல்லது வாய்ஸ் நோட் அனுப்புங்கள்.',
  },
  media: {
    kn: 'ಧನ್ಯವಾದಗಳು! ಇಲ್ಲಿ ಫೋಟೋ, ವೀಡಿಯೊ ಅಥವಾ ಫೈಲ್ ನೋಡಲು ಆಗುವುದಿಲ್ಲ. ನಿಮಗೆ ಏನು ಬೇಕು ಎಂದು ಸಂದೇಶದಲ್ಲಿ ತಿಳಿಸಿ.',
    te: 'ధన్యవాదాలు! ఇక్కడ ఫోటోలు, వీడియోలు లేదా ఫైల్‌లు చూడలేము. మీకు ఏం కావాలో మెసేజ్‌లో చెప్పండి.',
    ta: 'நன்றி! இங்கே புகைப்படம், வீடியோ அல்லது கோப்புகளைப் பார்க்க முடியாது. உங்களுக்கு என்ன வேண்டும் என்று செய்தியில் சொல்லுங்கள்.',
  },
  voiceFailed: {
    kn: 'ಆ ವಾಯ್ಸ್ ಸಂದೇಶ ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಬಹುದೇ?',
    te: 'ఆ వాయిస్ మెసేజ్ అర్థం కాలేదు. దయచేసి మీ ప్రశ్నను టైప్ చేయగలరా?',
    ta: 'அந்த வாய்ஸ் செய்தி புரியவில்லை. உங்கள் கேள்வியை டைப் செய்ய முடியுமா?',
  },
  rateLimited: {
    kn: 'ನೀವು ಕಡಿಮೆ ಸಮಯದಲ್ಲಿ ತುಂಬಾ ಸಂದೇಶಗಳನ್ನು ಕಳುಹಿಸಿದ್ದೀರಿ. ದಯವಿಟ್ಟು ಒಂದು ನಿಮಿಷ ಕಾದು ಮುಂದುವರಿಸಿ.',
    te: 'మీరు తక్కువ సమయంలో చాలా మెసేజ్‌లు పంపారు. దయచేసి ఒక నిమిషం ఆగి మళ్ళీ ప్రయత్నించండి.',
    ta: 'குறுகிய நேரத்தில் நிறைய செய்திகள் அனுப்பியுள்ளீர்கள். ஒரு நிமிடம் காத்திருந்து தொடருங்கள்.',
  },
  optedOut: {
    kn: 'ನಿಮ್ಮನ್ನು ಅನ್‌ಸಬ್‌ಸ್ಕ್ರೈಬ್ ಮಾಡಲಾಗಿದೆ: ಇನ್ನು ಮುಂದೆ ನಮ್ಮಿಂದ ರಿಮೈಂಡರ್ ಅಥವಾ ಅಪ್‌ಡೇಟ್ ಬರುವುದಿಲ್ಲ. ನೀವು ಯಾವಾಗ ಬೇಕಾದರೂ ಸಂದೇಶ ಕಳುಹಿಸಬಹುದು; ಮತ್ತೆ ಪಡೆಯಲು START ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'మిమ్మల్ని అన్‌సబ్‌స్క్రైబ్ చేశాం: ఇకపై మా నుండి రిమైండర్‌లు లేదా అప్‌డేట్‌లు రావు. మీరు ఎప్పుడైనా మెసేజ్ చేయవచ్చు; మళ్ళీ పొందడానికి START అని పంపండి.',
    ta: 'நீங்கள் அன்சப்ஸ்கிரைப் செய்யப்பட்டீர்கள்: இனி எங்களிடமிருந்து நினைவூட்டல்கள் அல்லது அப்டேட்கள் வராது. எப்போது வேண்டுமானாலும் செய்தி அனுப்பலாம்; மீண்டும் பெற START என்று அனுப்புங்கள்.',
  },
  optedIn: {
    kn: 'ನೀವು ಮತ್ತೆ ಸಬ್‌ಸ್ಕ್ರೈಬ್ ಆಗಿದ್ದೀರಿ: ಬುಕಿಂಗ್ ರಿಮೈಂಡರ್ ಮತ್ತು ಅಪ್‌ಡೇಟ್‌ಗಳು ಇಲ್ಲಿ ಬರುತ್ತವೆ. ನಿಲ್ಲಿಸಲು ಯಾವಾಗ ಬೇಕಾದರೂ STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'మీరు మళ్ళీ సబ్‌స్క్రైబ్ అయ్యారు: బుకింగ్ రిమైండర్‌లు, అప్‌డేట్‌లు ఇక్కడ వస్తాయి. ఆపడానికి ఎప్పుడైనా STOP అని పంపండి.',
    ta: 'நீங்கள் மீண்டும் சப்ஸ்கிரைப் செய்யப்பட்டீர்கள்: புக்கிங் நினைவூட்டல்கள், அப்டேட்கள் இங்கே வரும். நிறுத்த எப்போது வேண்டுமானாலும் STOP என்று அனுப்புங்கள்.',
  },
  error: {
    kn: 'ಈಗ ತಾಂತ್ರಿಕ ತೊಂದರೆ ಇದೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    te: 'ప్రస్తుతం సాంకేతిక సమస్య ఉంది. దయచేసి కాసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.',
    ta: 'இப்போது தொழில்நுட்பச் சிக்கல் உள்ளது. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.',
  },
};

// Template bodies: same parameters, in the same order, as the English ones.
// {{1}} business; confirmation/reminder/cancellation/no_show: {{2}} service, {{3}} when;
// recall: {{2}} "6 months", {{3}} service; review_request: {{2}} link.
export const TEMPLATE_BODIES: Record<'confirmation' | 'reminder' | 'cancellation' | 'missed_call' | 'recall' | 'no_show' | 'review_request', Record<DravidianLang, string>> = {
  confirmation: {
    kn: 'ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} {{3}} ಕ್ಕೆ ಖಚಿತವಾಗಿದೆ. ಬದಲಾಯಿಸಬೇಕಾದರೆ ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'నమస్కారం, {{1}} నుండి. మీ {{2}} {{3}} కి ఖరారైంది. మార్చాలంటే ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} {{3}} க்கு உறுதி செய்யப்பட்டது. மாற்ற வேண்டுமென்றால் இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  reminder: {
    kn: 'ನೆನಪಿಸುತ್ತಿದ್ದೇವೆ, {{1}} ಇಂದ: ನಿಮ್ಮ {{2}} {{3}} ಕ್ಕೆ ಇದೆ. ಸಮಯ ಬದಲಾಯಿಸಲು ಅಥವಾ ರದ್ದುಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'గుర్తుచేస్తున్నాం, {{1}} నుండి: మీ {{2}} {{3}} కి ఉంది. సమయం మార్చడానికి లేదా రద్దు చేయడానికి ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'நினைவூட்டல், {{1}} இலிருந்து: உங்கள் {{2}} {{3}} க்கு உள்ளது. நேரத்தை மாற்ற அல்லது ரத்து செய்ய இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  cancellation: {
    kn: 'ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} ({{3}}) ರದ್ದಾಗಿದೆ. ಹೊಸ ಸಮಯ ಬೇಕಾದರೆ ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'నమస్కారం, {{1}} నుండి. మీ {{2}} ({{3}}) రద్దు చేయబడింది. కొత్త సమయం కావాలంటే ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} ({{3}}) ரத்து செய்யப்பட்டது. புதிய நேரம் வேண்டுமென்றால் இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  missed_call: {
    kn: 'ಕ್ಷಮಿಸಿ, {{1}} ಗೆ ನಿಮ್ಮ ಕರೆ ಪೂರ್ಣವಾಗಲಿಲ್ಲ. ಈ ಸಂದೇಶಕ್ಕೆ ಉತ್ತರಿಸಿ, ಇಲ್ಲೇ WhatsApp ನಲ್ಲಿ ಸಹಾಯ ಮಾಡುತ್ತೇವೆ: ಬುಕಿಂಗ್, ಸಮಯ ಬದಲಾವಣೆ ಅಥವಾ ಯಾವುದೇ ಪ್ರಶ್ನೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'క్షమించండి, {{1}} కి మీ కాల్ పూర్తి కాలేదు. ఈ మెసేజ్‌కు రిప్లై చేయండి, ఇక్కడే WhatsApp లో సహాయం చేస్తాం: బుకింగ్, సమయం మార్పు లేదా ఏదైనా ప్రశ్న. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'மன்னிக்கவும், {{1}} க்கு உங்கள் அழைப்பு முழுமையடையவில்லை. இந்தச் செய்திக்குப் பதில் அனுப்புங்கள், இங்கேயே WhatsApp இல் உதவுகிறோம்: புக்கிங், நேர மாற்றம் அல்லது எந்தக் கேள்வியும். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  recall: {
    kn: 'ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ಸುಮಾರು {{2}} ಆಯಿತು ನಿಮ್ಮ ಕೊನೆಯ {{3}} ನಂತರ. ಮುಂದಿನ ಭೇಟಿ ಬುಕ್ ಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ, ನಾವು ಸಮಯ ಹುಡುಕುತ್ತೇವೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'నమస్కారం, {{1}} నుండి. దాదాపు {{2}} అయింది మీ చివరి {{3}} తర్వాత. తదుపరి విజిట్ బుక్ చేయడానికి ఇక్కడే రిప్లై చేయండి, మేము సమయం చూస్తాం. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'வணக்கம், {{1}} இலிருந்து. சுமார் {{2}} ஆகிவிட்டது உங்கள் கடைசி {{3}} க்குப் பிறகு. அடுத்த வருகையை புக் செய்ய இங்கேயே பதில் அனுப்புங்கள், நாங்கள் நேரம் பார்க்கிறோம். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  no_show: {
    kn: 'ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} ({{3}}) ಗೆ ನೀವು ಬರಲಿಲ್ಲ. ಹೊಸ ಸಮಯ ಬುಕ್ ಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ, ಅಥವಾ CALL ಎಂದು ಕಳುಹಿಸಿ, ಕ್ಲಿನಿಕ್ ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತದೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'నమస్కారం, {{1}} నుండి. మీ {{2}} ({{3}}) కి మీరు రాలేదు. కొత్త సమయం బుక్ చేయడానికి ఇక్కడే రిప్లై చేయండి, లేదా CALL అని పంపండి, క్లినిక్ మీకు కాల్ చేస్తుంది. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} ({{3}}) க்கு நீங்கள் வரவில்லை. புதிய நேரம் புக் செய்ய இங்கேயே பதில் அனுப்புங்கள், அல்லது CALL என்று அனுப்புங்கள், கிளினிக் உங்களை அழைக்கும். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
  review_request: {
    kn: 'ನಮಸ್ಕಾರ, {{1}} ಗೆ ಬಂದಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ಒಂದು ನಿಮಿಷ ಇದ್ದರೆ, Google ನಲ್ಲಿ ನಿಮ್ಮ ರಿವ್ಯೂ ನೀಡಿ: {{2}} ಅನುಭವ ಹೇಗಿತ್ತು ಎಂದು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ ಕ್ಲಿನಿಕ್‌ಗೆ ತಿಳಿಸಬಹುದು. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ.',
    te: 'నమస్కారం, {{1}} కి వచ్చినందుకు ధన్యవాదాలు. ఒక్క నిమిషం ఉంటే, Google లో మీ రివ్యూ ఇవ్వండి: {{2}} అనుభవం ఎలా ఉందో ఇక్కడే రిప్లై చేసి క్లినిక్‌కు చెప్పవచ్చు. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి.',
    ta: 'வணக்கம், {{1}} க்கு வந்ததற்கு நன்றி. ஒரு நிமிடம் இருந்தால், Google இல் உங்கள் ரிவ்யூவைத் தாருங்கள்: {{2}} அனுபவம் எப்படி இருந்தது என்று இங்கேயே பதில் அனுப்பி கிளினிக்கிடம் சொல்லலாம். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள்.',
  },
};

// Dates in messages: "today"/"tomorrow", a sample service name, "N months".
export const DATE_WORDS: Record<DravidianLang, { today: string; tomorrow: string; sample: string; months: (n: number) => string }> = {
  kn: { today: 'ಇಂದು', tomorrow: 'ನಾಳೆ', sample: 'ಸಮಾಲೋಚನೆ', months: n => `${n} ತಿಂಗಳು` },
  te: { today: 'ఈరోజు', tomorrow: 'రేపు', sample: 'కన్సల్టేషన్', months: n => `${n} నెలలు` },
  ta: { today: 'இன்று', tomorrow: 'நாளை', sample: 'ஆலோசனை', months: n => `${n} மாதங்கள்` },
};
