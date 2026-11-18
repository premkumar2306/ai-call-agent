// Every keyword list the guardrails use, in one place. Lower-case; matched as
// substrings of the caller's lower-cased words. A term is a safe-side guess:
// for emergencies and self-harm a false alarm costs one sentence, a miss costs
// more. Hindi/Hinglish/Kannada/Telugu/Tamil lists are first drafts and have
// not been reviewed by native speakers.

export type KwLang = 'en' | 'hi' | 'hi-en' | 'other';
export interface KeywordGroup { lang: KwLang; terms: string[] }

export const EMERGENCY: KeywordGroup[] = [
  { lang: 'en', terms: [
    'chest pain', 'pain in my chest', 'heart attack', "can't breathe", 'cannot breathe', 'trouble breathing', 'difficulty breathing',
    'short of breath', 'heavy bleeding', 'bleeding a lot', "won't stop bleeding", 'bleeding wont stop', 'severe bleeding',
    'severe pain', 'unbearable pain', 'terrible pain', 'unconscious', 'fainted', 'seizure', 'stroke', 'overdose', 'poisoned',
    'accident', 'choking', 'not breathing',
  ] },
  { lang: 'hi', terms: [
    'सीने में दर्द', 'सीने मे दर्द', 'सांस नहीं', 'साँस नहीं', 'सांस लेने में', 'साँस लेने में', 'बहुत खून', 'खून बंद नहीं', 'खून बह',
    'बेहोश', 'दौरा', 'हार्ट अटैक', 'एक्सीडेंट', 'दुर्घटना', 'असहनीय दर्द', 'बहुत तेज दर्द', 'बहुत तेज़ दर्द', 'ज़हर', 'जहर',
  ] },
  { lang: 'hi-en', terms: [
    'seene mein dard', 'seene me dard', 'chest mein dard', 'saans nahi', 'saans lene mein', 'bahut khoon', 'khoon band nahi',
    'khoon bah', 'behosh', 'bahut tez dard', 'asahniya dard', 'dil ka daura', 'accident ho gaya', 'accident hua',
  ] },
  { lang: 'other', terms: [
    'ಎದೆ ನೋವು', 'ಉಸಿರಾಡಲು', 'ರಕ್ತಸ್ರಾವ', 'ಅಪಘಾತ', 'ಪ್ರಜ್ಞೆ ತಪ್ಪ',
    'ఛాతీ నొప్పి', 'శ్వాస తీసుకోలేక', 'రక్తస్రావం', 'ప్రమాదం జరిగింది', 'స్పృహ తప్పి',
    'நெஞ்சு வலி', 'மூச்சு விட', 'இரத்தப்போக்கு', 'விபத்து', 'மயக்கம்',
  ] },
];

// Swelling alone is not an emergency; swelling plus trouble breathing or swallowing is.
export const SWELLING = ['swelling', 'swollen', 'सूजन', 'sujan', 'सूज'];
export const BREATH_OR_SWALLOW = ['breath', 'swallow', 'सांस', 'साँस', 'saans', 'निगल', 'nigal'];

export const SELF_HARM: KeywordGroup[] = [
  { lang: 'en', terms: ['kill myself', 'end my life', 'suicide', 'suicidal', 'want to die', 'hurt myself', 'self harm', 'self-harm', 'end it all', 'better off dead'] },
  { lang: 'hi', terms: ['आत्महत्या', 'खुदकुशी', 'मरना चाहता', 'मरना चाहती', 'जान दे दूं', 'जान दे दूँ'] },
  { lang: 'hi-en', terms: ['suicide karna', 'mar jana chahta', 'mar jana chahti', 'jaan de dunga', 'jaan de dungi', 'khudkushi'] },
  { lang: 'other', terms: ['ಆತ್ಮಹತ್ಯೆ', 'ఆత్మహత్య', 'தற்கொலை'] },
];

export const ABUSE: KeywordGroup[] = [
  { lang: 'en', terms: ['fuck', 'bitch', 'bastard', 'asshole', 'shut up', 'stupid bot', 'useless bot', 'kill you', 'hurt you', 'find you', 'you will pay', "you'll pay", 'burn the clinic', 'burn this place'] },
  { lang: 'hi', terms: ['मादरचोद', 'बहनचोद', 'भेनचोद', 'चूतिया', 'हरामी', 'गांडू', 'जान से मार'] },
  { lang: 'hi-en', terms: ['madarchod', 'behenchod', 'bhenchod', 'chutiya', 'chutia', 'harami', 'gandu', 'jaan se maar'] },
];

export const INJECTION: KeywordGroup[] = [
  { lang: 'en', terms: [
    'ignore your instructions', 'ignore previous instructions', 'ignore all previous', 'ignore the above', 'ignore your rules',
    'disregard your instructions', 'forget your instructions', 'system prompt', 'your prompt', 'your instructions', 'you are now',
    'pretend to be', 'pretend you are', 'jailbreak', 'developer mode', 'repeat the text above',
    'other patients', 'another patient', "someone else's appointment", "someone else's booking", "other people's", 'patient list',
    'list of patients', 'staff phone', 'staff number', "doctor's personal", "doctor's mobile", "doctor's cell", 'personal number of',
    'home address of',
  ] },
  { lang: 'hi', terms: ['अपने निर्देश भूल', 'पिछले निर्देश', 'सिस्टम प्रॉम्प्ट', 'दूसरे मरीज', 'किसी और की अपॉइंटमेंट', 'डॉक्टर का पर्सनल नंबर', 'स्टाफ का नंबर'] },
  { lang: 'hi-en', terms: ['pichle instructions', 'instructions bhool', 'system prompt', 'dusre mareez', 'dusre patient', 'doctor ka personal number', 'staff ka number'] },
];

// Requests for medical or legal advice, diagnosis or a prescription.
export const ADVICE: KeywordGroup[] = [
  { lang: 'en', terms: [
    'should i take', 'what medicine', 'which medicine', 'what tablet', 'which tablet', 'can i take', 'how much should i take', 'dosage',
    'is it serious', 'is it cancer', 'what is wrong with me', "what's wrong with me", 'what do i have', 'diagnose', 'prescribe',
    'home remedy', 'do i have a case', 'can i sue', 'should i sue', 'will i win', 'my chances', 'legal advice', 'is it legal',
  ] },
  { lang: 'hi', terms: ['कौन सी दवा', 'कौन सी गोली', 'दवा बताइए', 'दवा बताओ', 'क्या यह गंभीर', 'क्या यह कैंसर', 'क्या मैं केस जीत', 'क्या मेरा केस'] },
  { lang: 'hi-en', terms: ['kaun si dawai', 'konsi dawai', 'kaun si goli', 'dawai batao', 'dawa batao', 'kya yeh serious', 'kya main case jeet', 'kya mera case'] },
];

// Output checks (what the assistant must not say).
export const OUTCOME_PROMISES = /\b(guarantee[ds]?|100% (?:success|cure|safe)|will definitely (?:win|cure|heal|work)|no risk at all|certain to (?:win|work))\b/i;

export const BOOKING_CLAIMS = new RegExp([
  "you(?:'re| are) (?:all set|booked|confirmed)",
  "\\bi(?:'ve| have)? (?:booked|scheduled|confirmed)\\b",
  "(?:your|the) (?:appointment|booking) (?:is|has been) (?:booked|confirmed|scheduled|made)",
  'booking (?:is )?confirmed', 'appointment (?:is )?confirmed',
  'बुक कर दिया', 'बुक हो गया', 'बुक हो गई', 'कन्फर्म हो गया', 'कन्फर्म कर दिया',
  'book kar diya', 'book ho gaya', 'book ho gayi', 'confirm ho gaya', 'confirm kar diya',
].join('|'), 'i');
