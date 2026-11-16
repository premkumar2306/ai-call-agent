# Languages on the phone line and WhatsApp

| Language | `voice_language` | Speech in (STT) | Speech out (TTS) | Prompt rules | DPDP notice | WhatsApp templates | Status |
|---|---|---|---|---|---|---|---|
| English | `en` (default) | Deepgram or Sarvam `en-IN` | Cartesia or Sarvam | — | yes | yes | live |
| Hindi | `hi` | Deepgram `hi` or Sarvam `hi-IN` | Sarvam, or Cartesia with a Hindi voice id | yes | yes | yes | live |
| Hinglish | `hi-en` | Deepgram `multi` or Sarvam `hi-IN` codemix | as Hindi | yes | yes | yes | live |
| **Kannada** | `kn` | **Sarvam `kn-IN`** only | **Sarvam `kn-IN`** only | yes | yes | yes | new: needs native review + live test |
| **Telugu** | `te` | **Sarvam `te-IN`** only | **Sarvam `te-IN`** only | yes | yes | yes | new: needs native review + live test |
| **Tamil** | `ta` | **Sarvam `ta-IN`** only | **Sarvam `ta-IN`** only | yes | yes | yes | new: needs native review + live test |

Set per business in Settings → Assistant → Voice (`PUT /admin/sectors/:key/voice`). Picking
Kannada, Telugu or Tamil selects Sarvam for both directions, and the API refuses any other
combination, as well as Sarvam without `SARVAM_API_KEY`. Nothing changes for a business that
stays on English, including the US business.

## What each language gets

- **Speech:** Sarvam streaming STT `language-code=kn-IN|te-IN|ta-IN`, `mode=transcribe`; Sarvam
  TTS `language_code` the same (`stt-sarvam.ts`, `tts-sarvam.ts`).
- **Prompt rules** (`languageRules` / `chatLanguageRules`): reply in the caller's language, switch
  to English when they do, native script only (never romanised), polite clinic tone, "we" for the
  clinic, and numbers, prices, times and dates written as digits ("₹1,500", "4:30", "12 November").
  Sarvam normalises digits for the target language before speaking, so they're read naturally in
  Kannada, Telugu or Tamil.
- **Canned lines:** opener, greeting, fillers, "still there?", goodbye.
- **DPDP disclosure:** AI + transcription notice at the start of every call, plus the WhatsApp
  notice.
- **Turn-taking:** backchannel, floor-holder and dangling-word lists in each script.
- **WhatsApp:** all 7 template families (confirmation, reminder, cancellation, missed call,
  recall, no-show, review request) with Meta language codes `kn`, `te`, `ta`, and the automatic
  replies (opt-out/opt-in, unsupported media…). Dates use `kn-IN` / `te-IN` / `ta-IN` locale data
  plus the words for "today" and "tomorrow".
- **WhatsApp voice notes:** Deepgram language detection (`detect_language=true`).
  **Verify** accuracy on real Kannada/Telugu/Tamil voice notes. Sarvam batch STT would be the
  fallback if it's poor.

## Verification status

- **Sarvam language codes:** `kn-IN`, `te-IN`, `ta-IN` are the BCP-47 codes Sarvam uses for these
  languages, and Bulbul's docs list Kannada, Telugu and Tamil among its 11 languages
  ([Bulbul model page](https://docs.sarvam.ai/api/getting-started/models/bulbul),
  [TTS: set the language](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/how-to/set-the-language.md),
  [STT streaming](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws)). This session
  couldn't open docs.sarvam.ai (blocked by the network policy), so the exact code table wasn't read.
  **Verify with one live call per language** (the Sarvam check under Operator → Integrations
  confirms the key only).
- **Translations:** every string is listed in [translations-review.md](translations-review.md) for a
  native speaker to review. None has been reviewed yet.
- **e2e:** `npm run e2e -- kannada` / `telugu` / `tamil`. Each places a call over Exotel with the
  Sarvam stand-ins: notice in the language before the greeting, `kn-IN`/`te-IN`/`ta-IN` on both
  sockets, a native-script greeting, a spoken booking, transfer to staff, metering and the consent
  record.
