# Translations to review: Kannada, Telugu, Tamil

**Status: NEEDS REVIEW BY A NATIVE SPEAKER.** Every string below was written without one. Please check meaning, politeness
(a clinic front desk speaking to patients), natural word choice, and that nothing sounds machine-translated.
Mark corrections in the "Reviewer notes" column, or edit `worker/src/services/indic-languages.ts` directly.

Generated from `worker/src/services/indic-languages.ts` (do not edit by hand; run
`UPDATE_TRANSLATIONS=1 npx vitest run test/indic-languages.test.ts` in `worker/` after changing a string).

Placeholders: `{{1}}`, `{{2}}`, `{{3}}` are filled in by the system (business name, service, date/time, link). Keep them,
in the same order. `STOP`, `START` and `CALL` are keywords patients type: keep them in English letters.
"we" is used for the clinic throughout, to avoid gendered verb forms.

## Phone calls: what the assistant says

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| opener | Thanks for calling! | ನಮಸ್ಕಾರ! ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. | |
| greeting | You've reached {business}. I'm {assistant}, the virtual assistant. {hint} | {business} ಗೆ ಸ್ವಾಗತ. ನಾನು {assistant}, ವರ್ಚುವಲ್ ಅಸಿಸ್ಟೆಂಟ್. {hint} | |
| greeting (owner wrote their own) | {owner's greeting} I'm {assistant}, the virtual assistant. | {owner's greeting} ನಾನು {assistant}, ವರ್ಚುವಲ್ ಅಸಿಸ್ಟೆಂಟ್. | |
| hint | I can answer questions about our services and prices, or book you in — what can I do for you? | ನಮ್ಮ ಸೇವೆಗಳು ಮತ್ತು ದರಗಳ ಬಗ್ಗೆ ಹೇಳಬಹುದು, ಅಥವಾ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಬಹುದು — ಹೇಳಿ, ಏನು ಸಹಾಯ ಮಾಡಲಿ? | |
| hint (law firm) | I can tell you about our consultations and fees, or book a consultation with one of our lawyers. | ಕನ್ಸಲ್ಟೇಶನ್ ಮತ್ತು ಶುಲ್ಕದ ಬಗ್ಗೆ ಹೇಳಬಹುದು, ಅಥವಾ ವಕೀಲರ ಜೊತೆ ಕನ್ಸಲ್ಟೇಶನ್ ಬುಕ್ ಮಾಡಬಹುದು — ಹೇಳಿ, ಏನು ಸಹಾಯ ಮಾಡಲಿ? | |
| filler 1 | One moment. | ಒಂದು ಕ್ಷಣ. | |
| filler 2 | Let me check. | ನೋಡುತ್ತಿದ್ದೇವೆ. | |
| filler 3 | Just a second. | ಒಂದು ಸೆಕೆಂಡ್. | |
| still working 1 | Still checking, thanks for waiting. | ಇನ್ನೂ ನೋಡುತ್ತಿದ್ದೇವೆ, ದಯವಿಟ್ಟು ಕಾಯಿರಿ. | |
| still working 2 | Almost there. | ಬಹುತೇಕ ಆಯಿತು. | |
| still there? | Are you still there? | ನೀವು ಲೈನ್‌ನಲ್ಲಿ ಇದ್ದೀರಾ? | |
| goodbye (silence) | I haven't heard anything, so I'll hang up now. Thanks for calling {business}. Goodbye! | ಏನೂ ಕೇಳಿಸುತ್ತಿಲ್ಲ, ಆದ್ದರಿಂದ ಕರೆ ಮುಗಿಸುತ್ತಿದ್ದೇವೆ. {business} ಗೆ ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಮಸ್ಕಾರ! | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| opener | Thanks for calling! | నమస్కారం! కాల్ చేసినందుకు ధన్యవాదాలు. | |
| greeting | You've reached {business}. I'm {assistant}, the virtual assistant. {hint} | {business} కి స్వాగతం. నేను {assistant}, వర్చువల్ అసిస్టెంట్. {hint} | |
| greeting (owner wrote their own) | {owner's greeting} I'm {assistant}, the virtual assistant. | {owner's greeting} నేను {assistant}, వర్చువల్ అసిస్టెంట్. | |
| hint | I can answer questions about our services and prices, or book you in — what can I do for you? | మా సేవలు, ధరల గురించి చెప్పగలం, లేదా మీ అపాయింట్‌మెంట్ బుక్ చేయగలం — చెప్పండి, ఏం సహాయం చేయాలి? | |
| hint (law firm) | I can tell you about our consultations and fees, or book a consultation with one of our lawyers. | కన్సల్టేషన్, ఫీజుల గురించి చెప్పగలం, లేదా లాయర్‌తో కన్సల్టేషన్ బుక్ చేయగలం — చెప్పండి, ఏం సహాయం చేయాలి? | |
| filler 1 | One moment. | ఒక్క క్షణం. | |
| filler 2 | Let me check. | చూస్తున్నాం. | |
| filler 3 | Just a second. | ఒక్క సెకను. | |
| still working 1 | Still checking, thanks for waiting. | ఇంకా చూస్తున్నాం, దయచేసి వేచి ఉండండి. | |
| still working 2 | Almost there. | దాదాపు అయిపోయింది. | |
| still there? | Are you still there? | మీరు లైన్‌లో ఉన్నారా? | |
| goodbye (silence) | I haven't heard anything, so I'll hang up now. Thanks for calling {business}. Goodbye! | ఏమీ వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాం. {business} కి కాల్ చేసినందుకు ధన్యవాదాలు. నమస్కారం! | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| opener | Thanks for calling! | வணக்கம்! அழைத்ததற்கு நன்றி. | |
| greeting | You've reached {business}. I'm {assistant}, the virtual assistant. {hint} | {business} க்கு வரவேற்கிறோம். நான் {assistant}, வர்ச்சுவல் அசிஸ்டன்ட். {hint} | |
| greeting (owner wrote their own) | {owner's greeting} I'm {assistant}, the virtual assistant. | {owner's greeting} நான் {assistant}, வர்ச்சுவல் அசிஸ்டன்ட். | |
| hint | I can answer questions about our services and prices, or book you in — what can I do for you? | எங்கள் சேவைகள், கட்டணங்கள் பற்றி சொல்லலாம், அல்லது உங்கள் அப்பாயிண்ட்மென்ட்டை புக் செய்யலாம் — சொல்லுங்கள், என்ன உதவி வேண்டும்? | |
| hint (law firm) | I can tell you about our consultations and fees, or book a consultation with one of our lawyers. | கன்சல்டேஷன், கட்டணம் பற்றி சொல்லலாம், அல்லது வழக்கறிஞருடன் கன்சல்டேஷன் புக் செய்யலாம் — சொல்லுங்கள், என்ன உதவி வேண்டும்? | |
| filler 1 | One moment. | ஒரு நிமிடம். | |
| filler 2 | Let me check. | பார்க்கிறோம். | |
| filler 3 | Just a second. | ஒரு நொடி. | |
| still working 1 | Still checking, thanks for waiting. | இன்னும் பார்க்கிறோம், கொஞ்சம் காத்திருங்கள். | |
| still working 2 | Almost there. | கிட்டத்தட்ட முடிந்தது. | |
| still there? | Are you still there? | நீங்கள் லைனில் இருக்கிறீர்களா? | |
| goodbye (silence) | I haven't heard anything, so I'll hang up now. Thanks for calling {business}. Goodbye! | எதுவும் கேட்கவில்லை, அதனால் அழைப்பை முடிக்கிறோம். {business} அழைத்ததற்கு நன்றி. வணக்கம்! | |

## DPDP notice (spoken at the start of every call, and on WhatsApp)

Legal meaning must be exact: the patient is told they are talking to an AI and that the call is transcribed.

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| call notice | Just so you know, you're speaking with an AI assistant, and this call is transcribed so we can help you. Our privacy notice is linked in any text we send you. | ನಿಮ್ಮ ಮಾಹಿತಿಗಾಗಿ, ನೀವು AI ಸಹಾಯಕರ ಜೊತೆ ಮಾತನಾಡುತ್ತಿದ್ದೀರಿ, ಮತ್ತು ನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ಈ ಕರೆಯನ್ನು ಬರಹದಲ್ಲಿ ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ. ನಾವು ಕಳುಹಿಸುವ ಪ್ರತಿ ಸಂದೇಶದಲ್ಲಿ ನಮ್ಮ ಗೌಪ್ಯತಾ ಸೂಚನೆಯ ಲಿಂಕ್ ಇದೆ. | |
| WhatsApp notice | You're chatting with an AI assistant. Messages are stored so we can help you. | ನೀವು AI ಸಹಾಯಕರ ಜೊತೆ ಚಾಟ್ ಮಾಡುತ್ತಿದ್ದೀರಿ. ನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ಸಂದೇಶಗಳನ್ನು ಉಳಿಸಲಾಗುತ್ತದೆ. | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| call notice | Just so you know, you're speaking with an AI assistant, and this call is transcribed so we can help you. Our privacy notice is linked in any text we send you. | మీ సమాచారం కోసం, మీరు AI సహాయకుడితో మాట్లాడుతున్నారు, మీకు సహాయం చేయడానికి ఈ కాల్‌ను రాతపూర్వకంగా నమోదు చేస్తున్నాం. మేము పంపే ప్రతి మెసేజ్‌లో మా గోప్యతా నోటీసు లింక్ ఉంటుంది. | |
| WhatsApp notice | You're chatting with an AI assistant. Messages are stored so we can help you. | మీరు AI సహాయకుడితో చాట్ చేస్తున్నారు. మీకు సహాయం చేయడానికి మెసేజ్‌లు సేవ్ చేయబడతాయి. | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| call notice | Just so you know, you're speaking with an AI assistant, and this call is transcribed so we can help you. Our privacy notice is linked in any text we send you. | உங்கள் தகவலுக்கு, நீங்கள் ஒரு AI உதவியாளருடன் பேசுகிறீர்கள், உங்களுக்கு உதவ இந்த அழைப்பு எழுத்து வடிவில் பதிவு செய்யப்படுகிறது. நாங்கள் அனுப்பும் ஒவ்வொரு செய்தியிலும் எங்கள் தனியுரிமை அறிவிப்பின் இணைப்பு உள்ளது. | |
| WhatsApp notice | You're chatting with an AI assistant. Messages are stored so we can help you. | நீங்கள் ஒரு AI உதவியாளருடன் உரையாடுகிறீர்கள். உங்களுக்கு உதவ செய்திகள் சேமிக்கப்படுகின்றன. | |

## WhatsApp templates (submitted to Meta for approval)

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| avery_booking_confirmation (confirmation) | Hello from {{1}}. Your {{2}} is confirmed for {{3}}. Reply here if you need to change it. Reply STOP to opt out. | ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} {{3}} ಕ್ಕೆ ಖಚಿತವಾಗಿದೆ. ಬದಲಾಯಿಸಬೇಕಾದರೆ ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_appointment_reminder (reminder) | Reminder from {{1}}: your {{2}} is {{3}}. Reply here to reschedule or cancel. Reply STOP to opt out. | ನೆನಪಿಸುತ್ತಿದ್ದೇವೆ, {{1}} ಇಂದ: ನಿಮ್ಮ {{2}} {{3}} ಕ್ಕೆ ಇದೆ. ಸಮಯ ಬದಲಾಯಿಸಲು ಅಥವಾ ರದ್ದುಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_booking_cancellation (cancellation) | Hello from {{1}}. Your {{2}} on {{3}} has been cancelled. Reply here if you would like a new time. Reply STOP to opt out. | ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} ({{3}}) ರದ್ದಾಗಿದೆ. ಹೊಸ ಸಮಯ ಬೇಕಾದರೆ ಇಲ್ಲೇ ಉತ್ತರಿಸಿ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_missed_call (missed_call) | Sorry we missed your call to {{1}}. Reply to this message and we will help you here on WhatsApp: book, reschedule or ask a question. Reply STOP to opt out. | ಕ್ಷಮಿಸಿ, {{1}} ಗೆ ನಿಮ್ಮ ಕರೆ ಪೂರ್ಣವಾಗಲಿಲ್ಲ. ಈ ಸಂದೇಶಕ್ಕೆ ಉತ್ತರಿಸಿ, ಇಲ್ಲೇ WhatsApp ನಲ್ಲಿ ಸಹಾಯ ಮಾಡುತ್ತೇವೆ: ಬುಕಿಂಗ್, ಸಮಯ ಬದಲಾವಣೆ ಅಥವಾ ಯಾವುದೇ ಪ್ರಶ್ನೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_recall (recall) | Hello from {{1}}. It has been about {{2}} since your last {{3}}. Reply here to book your next visit, and we will find you a time. Reply STOP to opt out. | ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ಸುಮಾರು {{2}} ಆಯಿತು ನಿಮ್ಮ ಕೊನೆಯ {{3}} ನಂತರ. ಮುಂದಿನ ಭೇಟಿ ಬುಕ್ ಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ, ನಾವು ಸಮಯ ಹುಡುಕುತ್ತೇವೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_missed_appointment (no_show) | Hello from {{1}}. We missed you at your {{2}} on {{3}}. Reply here to book a new time, or reply CALL and the clinic will call you back. Reply STOP to opt out. | ನಮಸ್ಕಾರ, {{1}} ಇಂದ. ನಿಮ್ಮ {{2}} ({{3}}) ಗೆ ನೀವು ಬರಲಿಲ್ಲ. ಹೊಸ ಸಮಯ ಬುಕ್ ಮಾಡಲು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ, ಅಥವಾ CALL ಎಂದು ಕಳುಹಿಸಿ, ಕ್ಲಿನಿಕ್ ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತದೆ. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| avery_review_request (review_request) | Thank you for visiting {{1}}. If you have a minute, we would value your review on Google: {{2}} You can also reply here to tell the clinic how it went. Reply STOP to opt out. | ನಮಸ್ಕಾರ, {{1}} ಗೆ ಬಂದಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ಒಂದು ನಿಮಿಷ ಇದ್ದರೆ, Google ನಲ್ಲಿ ನಿಮ್ಮ ರಿವ್ಯೂ ನೀಡಿ: {{2}} ಅನುಭವ ಹೇಗಿತ್ತು ಎಂದು ಇಲ್ಲೇ ಉತ್ತರಿಸಿ ಕ್ಲಿನಿಕ್‌ಗೆ ತಿಳಿಸಬಹುದು. ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಎಂದು ಕಳುಹಿಸಿ. | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| avery_booking_confirmation (confirmation) | Hello from {{1}}. Your {{2}} is confirmed for {{3}}. Reply here if you need to change it. Reply STOP to opt out. | నమస్కారం, {{1}} నుండి. మీ {{2}} {{3}} కి ఖరారైంది. మార్చాలంటే ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_appointment_reminder (reminder) | Reminder from {{1}}: your {{2}} is {{3}}. Reply here to reschedule or cancel. Reply STOP to opt out. | గుర్తుచేస్తున్నాం, {{1}} నుండి: మీ {{2}} {{3}} కి ఉంది. సమయం మార్చడానికి లేదా రద్దు చేయడానికి ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_booking_cancellation (cancellation) | Hello from {{1}}. Your {{2}} on {{3}} has been cancelled. Reply here if you would like a new time. Reply STOP to opt out. | నమస్కారం, {{1}} నుండి. మీ {{2}} ({{3}}) రద్దు చేయబడింది. కొత్త సమయం కావాలంటే ఇక్కడే రిప్లై చేయండి. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_missed_call (missed_call) | Sorry we missed your call to {{1}}. Reply to this message and we will help you here on WhatsApp: book, reschedule or ask a question. Reply STOP to opt out. | క్షమించండి, {{1}} కి మీ కాల్ పూర్తి కాలేదు. ఈ మెసేజ్‌కు రిప్లై చేయండి, ఇక్కడే WhatsApp లో సహాయం చేస్తాం: బుకింగ్, సమయం మార్పు లేదా ఏదైనా ప్రశ్న. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_recall (recall) | Hello from {{1}}. It has been about {{2}} since your last {{3}}. Reply here to book your next visit, and we will find you a time. Reply STOP to opt out. | నమస్కారం, {{1}} నుండి. దాదాపు {{2}} అయింది మీ చివరి {{3}} తర్వాత. తదుపరి విజిట్ బుక్ చేయడానికి ఇక్కడే రిప్లై చేయండి, మేము సమయం చూస్తాం. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_missed_appointment (no_show) | Hello from {{1}}. We missed you at your {{2}} on {{3}}. Reply here to book a new time, or reply CALL and the clinic will call you back. Reply STOP to opt out. | నమస్కారం, {{1}} నుండి. మీ {{2}} ({{3}}) కి మీరు రాలేదు. కొత్త సమయం బుక్ చేయడానికి ఇక్కడే రిప్లై చేయండి, లేదా CALL అని పంపండి, క్లినిక్ మీకు కాల్ చేస్తుంది. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |
| avery_review_request (review_request) | Thank you for visiting {{1}}. If you have a minute, we would value your review on Google: {{2}} You can also reply here to tell the clinic how it went. Reply STOP to opt out. | నమస్కారం, {{1}} కి వచ్చినందుకు ధన్యవాదాలు. ఒక్క నిమిషం ఉంటే, Google లో మీ రివ్యూ ఇవ్వండి: {{2}} అనుభవం ఎలా ఉందో ఇక్కడే రిప్లై చేసి క్లినిక్‌కు చెప్పవచ్చు. మెసేజ్‌లు ఆపడానికి STOP అని పంపండి. | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| avery_booking_confirmation (confirmation) | Hello from {{1}}. Your {{2}} is confirmed for {{3}}. Reply here if you need to change it. Reply STOP to opt out. | வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} {{3}} க்கு உறுதி செய்யப்பட்டது. மாற்ற வேண்டுமென்றால் இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_appointment_reminder (reminder) | Reminder from {{1}}: your {{2}} is {{3}}. Reply here to reschedule or cancel. Reply STOP to opt out. | நினைவூட்டல், {{1}} இலிருந்து: உங்கள் {{2}} {{3}} க்கு உள்ளது. நேரத்தை மாற்ற அல்லது ரத்து செய்ய இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_booking_cancellation (cancellation) | Hello from {{1}}. Your {{2}} on {{3}} has been cancelled. Reply here if you would like a new time. Reply STOP to opt out. | வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} ({{3}}) ரத்து செய்யப்பட்டது. புதிய நேரம் வேண்டுமென்றால் இங்கேயே பதில் அனுப்புங்கள். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_missed_call (missed_call) | Sorry we missed your call to {{1}}. Reply to this message and we will help you here on WhatsApp: book, reschedule or ask a question. Reply STOP to opt out. | மன்னிக்கவும், {{1}} க்கு உங்கள் அழைப்பு முழுமையடையவில்லை. இந்தச் செய்திக்குப் பதில் அனுப்புங்கள், இங்கேயே WhatsApp இல் உதவுகிறோம்: புக்கிங், நேர மாற்றம் அல்லது எந்தக் கேள்வியும். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_recall (recall) | Hello from {{1}}. It has been about {{2}} since your last {{3}}. Reply here to book your next visit, and we will find you a time. Reply STOP to opt out. | வணக்கம், {{1}} இலிருந்து. சுமார் {{2}} ஆகிவிட்டது உங்கள் கடைசி {{3}} க்குப் பிறகு. அடுத்த வருகையை புக் செய்ய இங்கேயே பதில் அனுப்புங்கள், நாங்கள் நேரம் பார்க்கிறோம். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_missed_appointment (no_show) | Hello from {{1}}. We missed you at your {{2}} on {{3}}. Reply here to book a new time, or reply CALL and the clinic will call you back. Reply STOP to opt out. | வணக்கம், {{1}} இலிருந்து. உங்கள் {{2}} ({{3}}) க்கு நீங்கள் வரவில்லை. புதிய நேரம் புக் செய்ய இங்கேயே பதில் அனுப்புங்கள், அல்லது CALL என்று அனுப்புங்கள், கிளினிக் உங்களை அழைக்கும். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |
| avery_review_request (review_request) | Thank you for visiting {{1}}. If you have a minute, we would value your review on Google: {{2}} You can also reply here to tell the clinic how it went. Reply STOP to opt out. | வணக்கம், {{1}} க்கு வந்ததற்கு நன்றி. ஒரு நிமிடம் இருந்தால், Google இல் உங்கள் ரிவ்யூவைத் தாருங்கள்: {{2}} அனுபவம் எப்படி இருந்தது என்று இங்கேயே பதில் அனுப்பி கிளினிக்கிடம் சொல்லலாம். செய்திகளை நிறுத்த STOP என்று அனுப்புங்கள். | |

## WhatsApp automatic replies

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| unsupported | Sorry, I can't open that kind of message. Please type your question, or send a voice note. | ಕ್ಷಮಿಸಿ, ಈ ರೀತಿಯ ಸಂದೇಶವನ್ನು ತೆರೆಯಲು ಆಗುವುದಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ, ಅಥವಾ ವಾಯ್ಸ್ ನೋಟ್ ಕಳುಹಿಸಿ. | |
| media | Thanks! I can't view photos, videos or files here. Please tell me in a message what you need, and our team will see what you sent. | ಧನ್ಯವಾದಗಳು! ಇಲ್ಲಿ ಫೋಟೋ, ವೀಡಿಯೊ ಅಥವಾ ಫೈಲ್ ನೋಡಲು ಆಗುವುದಿಲ್ಲ. ನಿಮಗೆ ಏನು ಬೇಕು ಎಂದು ಸಂದೇಶದಲ್ಲಿ ತಿಳಿಸಿ. | |
| voiceFailed | I couldn't make out that voice message. Could you type your request instead? | ಆ ವಾಯ್ಸ್ ಸಂದೇಶ ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಬಹುದೇ? | |
| rateLimited | You've sent a lot of messages in a short time. Please wait a minute, then continue. | ನೀವು ಕಡಿಮೆ ಸಮಯದಲ್ಲಿ ತುಂಬಾ ಸಂದೇಶಗಳನ್ನು ಕಳುಹಿಸಿದ್ದೀರಿ. ದಯವಿಟ್ಟು ಒಂದು ನಿಮಿಷ ಕಾದು ಮುಂದುವರಿಸಿ. | |
| optedOut | You've been unsubscribed: no more reminders or updates from us here. You can still message us any time, and reply START to get them again. | ನಿಮ್ಮನ್ನು ಅನ್‌ಸಬ್‌ಸ್ಕ್ರೈಬ್ ಮಾಡಲಾಗಿದೆ: ಇನ್ನು ಮುಂದೆ ನಮ್ಮಿಂದ ರಿಮೈಂಡರ್ ಅಥವಾ ಅಪ್‌ಡೇಟ್ ಬರುವುದಿಲ್ಲ. ನೀವು ಯಾವಾಗ ಬೇಕಾದರೂ ಸಂದೇಶ ಕಳುಹಿಸಬಹುದು; ಮತ್ತೆ ಪಡೆಯಲು START ಎಂದು ಕಳುಹಿಸಿ. | |
| optedIn | You're subscribed again: we'll send booking reminders and updates here. Reply STOP any time to stop. | ನೀವು ಮತ್ತೆ ಸಬ್‌ಸ್ಕ್ರೈಬ್ ಆಗಿದ್ದೀರಿ: ಬುಕಿಂಗ್ ರಿಮೈಂಡರ್ ಮತ್ತು ಅಪ್‌ಡೇಟ್‌ಗಳು ಇಲ್ಲಿ ಬರುತ್ತವೆ. ನಿಲ್ಲಿಸಲು ಯಾವಾಗ ಬೇಕಾದರೂ STOP ಎಂದು ಕಳುಹಿಸಿ. | |
| error | I'm having technical difficulties. Please try again shortly. | ಈಗ ತಾಂತ್ರಿಕ ತೊಂದರೆ ಇದೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ. | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| unsupported | Sorry, I can't open that kind of message. Please type your question, or send a voice note. | క్షమించండి, ఈ రకమైన మెసేజ్‌ను తెరవలేము. దయచేసి మీ ప్రశ్నను టైప్ చేయండి, లేదా వాయిస్ నోట్ పంపండి. | |
| media | Thanks! I can't view photos, videos or files here. Please tell me in a message what you need, and our team will see what you sent. | ధన్యవాదాలు! ఇక్కడ ఫోటోలు, వీడియోలు లేదా ఫైల్‌లు చూడలేము. మీకు ఏం కావాలో మెసేజ్‌లో చెప్పండి. | |
| voiceFailed | I couldn't make out that voice message. Could you type your request instead? | ఆ వాయిస్ మెసేజ్ అర్థం కాలేదు. దయచేసి మీ ప్రశ్నను టైప్ చేయగలరా? | |
| rateLimited | You've sent a lot of messages in a short time. Please wait a minute, then continue. | మీరు తక్కువ సమయంలో చాలా మెసేజ్‌లు పంపారు. దయచేసి ఒక నిమిషం ఆగి మళ్ళీ ప్రయత్నించండి. | |
| optedOut | You've been unsubscribed: no more reminders or updates from us here. You can still message us any time, and reply START to get them again. | మిమ్మల్ని అన్‌సబ్‌స్క్రైబ్ చేశాం: ఇకపై మా నుండి రిమైండర్‌లు లేదా అప్‌డేట్‌లు రావు. మీరు ఎప్పుడైనా మెసేజ్ చేయవచ్చు; మళ్ళీ పొందడానికి START అని పంపండి. | |
| optedIn | You're subscribed again: we'll send booking reminders and updates here. Reply STOP any time to stop. | మీరు మళ్ళీ సబ్‌స్క్రైబ్ అయ్యారు: బుకింగ్ రిమైండర్‌లు, అప్‌డేట్‌లు ఇక్కడ వస్తాయి. ఆపడానికి ఎప్పుడైనా STOP అని పంపండి. | |
| error | I'm having technical difficulties. Please try again shortly. | ప్రస్తుతం సాంకేతిక సమస్య ఉంది. దయచేసి కాసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి. | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| unsupported | Sorry, I can't open that kind of message. Please type your question, or send a voice note. | மன்னிக்கவும், இந்த வகை செய்தியைத் திறக்க முடியவில்லை. உங்கள் கேள்வியை டைப் செய்யுங்கள், அல்லது வாய்ஸ் நோட் அனுப்புங்கள். | |
| media | Thanks! I can't view photos, videos or files here. Please tell me in a message what you need, and our team will see what you sent. | நன்றி! இங்கே புகைப்படம், வீடியோ அல்லது கோப்புகளைப் பார்க்க முடியாது. உங்களுக்கு என்ன வேண்டும் என்று செய்தியில் சொல்லுங்கள். | |
| voiceFailed | I couldn't make out that voice message. Could you type your request instead? | அந்த வாய்ஸ் செய்தி புரியவில்லை. உங்கள் கேள்வியை டைப் செய்ய முடியுமா? | |
| rateLimited | You've sent a lot of messages in a short time. Please wait a minute, then continue. | குறுகிய நேரத்தில் நிறைய செய்திகள் அனுப்பியுள்ளீர்கள். ஒரு நிமிடம் காத்திருந்து தொடருங்கள். | |
| optedOut | You've been unsubscribed: no more reminders or updates from us here. You can still message us any time, and reply START to get them again. | நீங்கள் அன்சப்ஸ்கிரைப் செய்யப்பட்டீர்கள்: இனி எங்களிடமிருந்து நினைவூட்டல்கள் அல்லது அப்டேட்கள் வராது. எப்போது வேண்டுமானாலும் செய்தி அனுப்பலாம்; மீண்டும் பெற START என்று அனுப்புங்கள். | |
| optedIn | You're subscribed again: we'll send booking reminders and updates here. Reply STOP any time to stop. | நீங்கள் மீண்டும் சப்ஸ்கிரைப் செய்யப்பட்டீர்கள்: புக்கிங் நினைவூட்டல்கள், அப்டேட்கள் இங்கே வரும். நிறுத்த எப்போது வேண்டுமானாலும் STOP என்று அனுப்புங்கள். | |
| error | I'm having technical difficulties. Please try again shortly. | இப்போது தொழில்நுட்பச் சிக்கல் உள்ளது. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும். | |

## Dates and small words

Weekday and month names come from the browser/Intl locale data (kn-IN, te-IN, ta-IN), not from this list.

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| today | today | ಇಂದು | |
| tomorrow | tomorrow | ನಾಳೆ | |
| sample service (previews) | Consultation | ಸಮಾಲೋಚನೆ | |
| 6 months | 6 months | 6 ತಿಂಗಳು | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| today | today | ఈరోజు | |
| tomorrow | tomorrow | రేపు | |
| sample service (previews) | Consultation | కన్సల్టేషన్ | |
| 6 months | 6 months | 6 నెలలు | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| today | today | இன்று | |
| tomorrow | tomorrow | நாளை | |
| sample service (previews) | Consultation | ஆலோசனை | |
| 6 months | 6 months | 6 மாதங்கள் | |

## Turn-taking word lists (speech recognition)

Please add common words (and the romanised spellings speech recognition produces) that are missing.

### Kannada (ಕನ್ನಡ)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| backchannels (listener feedback: "yes", "ok") | yes, ok, hmm | ಹೌದು, ಹೂಂ, ಹೂ, ಸರಿ, ಓಕೆ, ಆಯ್ತು, ಹಾ, ಹ್ಮ್, ಹಾಂ, houdu, sari, aytu, hoon, hu | |
| floor-holders ("so", "I mean") | so, I mean, but | ಅಂದ್ರೆ, ಮತ್ತೆ, ಆದರೆ, ಅದು, ಅಂದರೆ, ನೋಡಿ | |
| words a sentence does not end on | and, or, but, my, our, because | ಮತ್ತು, ಅಥವಾ, ಆದರೆ, ನನ್ನ, ನಮ್ಮ, ಯಾಕೆಂದರೆ | |

### Telugu (తెలుగు)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| backchannels (listener feedback: "yes", "ok") | yes, ok, hmm | అవును, ఆ, సరే, ఓకే, హా, హ్మ్, ఊ, అలాగే, avunu, sare, haa, alage | |
| floor-holders ("so", "I mean") | so, I mean, but | అంటే, మరి, కానీ, అది, చూడండి | |
| words a sentence does not end on | and, or, but, my, our, because | మరియు, లేదా, కానీ, నా, మా, ఎందుకంటే | |

### Tamil (தமிழ்)

| Key | English meaning | Text | Reviewer notes |
|---|---|---|---|
| backchannels (listener feedback: "yes", "ok") | yes, ok, hmm | ஆமா, ஆமாம், சரி, ஓகே, ம், ம்ம், ஹா, சரிங்க, aama, aamaa, sari, seri | |
| floor-holders ("so", "I mean") | so, I mean, but | அதாவது, அப்புறம், ஆனா, அது, பாருங்க | |
| words a sentence does not end on | and, or, but, my, our, because | மற்றும், அல்லது, ஆனா, என், எங்கள், ஏனென்றால் | |

