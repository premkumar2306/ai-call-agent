# Cost rates: what the code assumes vs. list prices

Source of the code values: `worker/src/services/billing/pricing.ts` (`DEFAULT_COST_RATES`), tunable with `BILLING_COST_RATES`.
Checked 2026-11-20 from a sandbox that could reach only the Anthropic pricing page directly; everything else is from
web-search summaries of vendor and third-party pages and is marked **UNVERIFIED** (no vendor page read). No code value was changed.

| Rate | Code value | Current list price | Source | Status |
|---|---|---|---|---|
| FX ₹/$ | 88 | Not checked | n/a | UNVERIFIED (set it to the rate you want; override `usdToInr`) |
| Twilio per minute | $0.0085 | Not read (Twilio blocked) | https://www.twilio.com/en-us/voice/pricing/us | UNVERIFIED |
| Exotel per minute | $0.006 (≈ ₹0.53) | Not read (Exotel blocked) | https://exotel.com/pricing/ | UNVERIFIED |
| Plivo per minute | $0.006 | Not read (Plivo blocked) | https://www.plivo.com/voice/pricing/in/ | UNVERIFIED |
| Carrier rounding | every started minute, all carriers | Not read | carrier pricing pages | UNVERIFIED (Twilio and Exotel/Plivo may bill per second or 60/1 pulses; confirm in your contract) |
| Deepgram nova-3, English streaming | $0.0077/min | $0.0077/min regular; $0.0048/min limited-time promo (search summary of Deepgram's page) | https://deepgram.com/pricing | MATCH to the regular rate, UNVERIFIED (page not read). Code ignores the promo, so it overstates while the promo lasts |
| Deepgram nova-3, Hindi / Hinglish (`hi`, `multi`) | $0.0077/min (same rate) | Multilingual $0.0092/min regular, $0.0058 promo (search summaries) | https://deepgram.com/pricing | LIKELY MISMATCH (code ~16% low for Hindi/Hinglish on Deepgram), UNVERIFIED |
| Sarvam STT (saaras) | ₹30/hour | ₹30/hour (search summary of Sarvam's page; the page does not name Saaras) | https://docs.sarvam.ai/api/pricing | MATCH, UNVERIFIED |
| Cartesia TTS (sonic-3.5) | $0.00003/char | ~1 credit per character; plans Pro $5 / 100K credits ($0.00005), Startup $49 / 1.25M ($0.0000392), Scale $299 / 8M ($0.0000374) | https://docs.cartesia.ai/pricing | LIKELY MISMATCH (code is 20–40% below every listed plan), UNVERIFIED |
| Sarvam TTS (bulbul:v3, the code default) | ₹15 / 10K chars | Bulbul v3 ₹30 / 10K chars; v2 ₹15 / 10K chars (search summaries) | https://docs.sarvam.ai/api/pricing | LIKELY MISMATCH (code has the v2 price but runs v3; Hindi TTS cost understated by half), UNVERIFIED |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | in $0.10, out $0.50, cache read $0.01, cache write $0.125 per MTok | Same, for prompts up to 100K tokens | https://platform.claude.com/docs/en/about-claude/pricing | **MATCH (verified, page read)** |
| Claude Haiku 4.5 | $1 / $5 / read $0.10 / write $1.25 | Same | same | **MATCH (verified)** |
| Claude Sonnet 5.5 | $2 / $10 / read $0.10 / write $2.50 | Same | same | **MATCH (verified)** |
| Haiku 5.5 above 100K prompt tokens | not modelled | $0.50 / $2.50 / read $0.05 / write $0.625 for the whole request | same | GAP: voice prompts are far below 100K, so no effect today |
| WhatsApp conversation | $0 | Not checked | n/a | UNVERIFIED |

## Summary
Verified 3 (Anthropic models). Matched but unverified 2. Likely mismatched 3 (Deepgram Hindi, Cartesia, Sarvam TTS v3). Unverified 7.
Changes made to `pricing.ts`: none (the mismatches rest on search summaries, not a vendor page I could read).
To fix them once confirmed, no deploy is needed: set `BILLING_COST_RATES`, for example
`{"ttsPerCharByProvider":{"cartesia":0.0000392,"sarvam":0.0003409}}` (₹30 per 10K chars at ₹88/$).
Hosts to allow in the session network to finish the check: deepgram.com, docs.cartesia.ai, docs.sarvam.ai, www.twilio.com, exotel.com, www.plivo.com.

## Models in use (from code config)
| Part | Provider and model | Where |
|---|---|---|
| STT, English | Deepgram `nova-3` (or `DG_MODEL`, e.g. a `flux-*` model) | `stt-deepgram.ts`, `voice-providers.ts` |
| STT, Hindi/Hinglish on Deepgram | `nova-3` (flux never used) | `voice-providers.ts` |
| STT, Sarvam | `saaras:v3` (or `SARVAM_STT_MODEL`) | `stt-sarvam.ts` |
| TTS, Cartesia | `sonic-3.5` (or `CARTESIA_MODEL_ID`) | `tts-cartesia.ts` |
| TTS, Sarvam | `bulbul:v3` (or `SARVAM_TTS_MODEL`) | `tts-sarvam.ts` |
| AI | `claude-haiku-5-5` (or `VOICE_MODEL`) | `config.ts` |

Each call now records these (migration `0031_usage_speech_models.sql`; older calls show "—").

## How the maths reconciles
Cost of a call = telephony (started minutes × carrier rate) + STT seconds × rate + TTS characters × rate + Σ tokens (input, output, cache read, cache write) × model rate. Tests: `worker/test/cost-reconcile.test.ts`.
Per-turn costs (turn timeline) sum to the call total **except** the following, which only the call total carries: the phone line (billed per call), the greeting, canned lines and silence prompts (spoken outside any turn but metered), and listening time between turns. TTS is metered only when synthesis succeeded; a greeting dropped after a voice change is requested but not metered (small undercount).
