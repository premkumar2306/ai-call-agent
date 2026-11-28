# Human-like conversation: design (Phase 2)

Status: draft for approval. Builds on `docs/research/call-experience-findings.md` (read it first). No code is written until this is approved.

## Principle

A human receptionist (1) waits until you have finished *meaning* something, (2) stops talking quickly when you cut in, (3) ignores "hmm" and noise, (4) speaks at a pace you can follow, and (5) says something small instead of going silent. We build each as a mechanism with a measurable target, not a tuned timer.

## Building on the other branches

- `claude/voice-experience` (WIP, one commit, migration 0035) adds the knobs: `speaking_rate` (slow 0.9 / normal / fast 1.1), `interruption_sensitivity`, `endpointing` (patient = 700 ms on Deepgram, settle time on Sarvam), `noise_cancellation`, with India-automatic defaults. We use these as-is. Our work changes what the *mechanisms* do at those settings and what the defaults should be. Two things to check there: the automatic set applies to `country_code = IN`, which covers the Sarvam business; and the default rate 0.9 may not be enough against a 30% faster Sarvam pace (see 4).
- `claude/voice-naturalness` (PR #127, migration 0033) adds the cached filler/greeting audio (`services/audio-cache.ts`) and `sectors.natural_fillers`. We reuse that cache for acknowledgements (5). Both migrations need renumbering against each other; whoever merges second does it.

## 1. Semantic end-of-turn (replaces fixed holds)

Problem (root cause 3): first audio p50 1.7 s; ~0.9 s of it is waiting on a timer; the timer is blind to meaning.

Mechanism: an `EndOfTurnJudge` that, once the STT says "maybe done", scores the transcript so far and returns `complete | incomplete | wait_more` with a hold in ms:
- Rules first, per language (cheap, 0 ms): ends with `?` or `।`/`.`; a question word pattern; a number or time that completes a slot the agent asked for ("what's your number?" -> 10 digits); dangling conjunction/preposition lists (existing lists, extended for Hindi/Telugu/Tamil: "और", "लेकिन", "क्योंकि", "aur", "but").
- Context: the agent's last question decides what "complete" means. A name after "what's your name?" is complete at 1-2 words; a date answer is complete once a day and a time are present.
- Prosody/timing: the STT's own end signal and word timestamps (Deepgram `speech_final`, Sarvam END_SPEECH). A falling trailing silence of less than 300 ms after a complete sentence is released immediately; a trailing "and..." or a word cut off holds.
- Optional fast classifier (Haiku-class, ~150-250 ms, 1 call per ambiguous turn only), run on the interim text in parallel with the first LLM call; if it says `incomplete`, the response is cancelled before any audio is sent. Latency budget: 250 ms; on a timeout it falls back to the rules. Off by default, enabled per business for evaluation.
- Holds become: complete 0-150 ms, ambiguous 400 ms, incomplete 900-1200 ms (patient), always cancelled by new speech. This replaces `statementHoldMs` / `incompleteHoldMs` magic numbers with one tested function.

Sarvam: no interim results, so the judge sees only the final text and Sarvam's own END_SPEECH; the settle time (voice-experience) is the only lever, and the judge's `incomplete` verdict extends it. Documented limit: Sarvam cannot yield mid-sentence on words (see 2).

Targets: first-audio p50 <= 1.0 s, p90 <= 1.8 s on complete turns; mid-sentence-pause replies (needs timestamps, see Measurement) <= 5%.

## 2. Yielding like a human

Problem (root cause 1): clear takes median 2.4 s, up to 4.1 s.

Mechanism: a single `InterruptionClassifier` replacing the scattered checks in `bargeInDecision`, `handleSpeechStart` and `handleTranscript`. Inputs: voiced duration (VAD, ms), word count and confidence, backchannel lexicon per language (English, Hindi/Hinglish, Dravidian lists already exist), echo check, and "addressed to the agent" (not a lone word, not the echo of the agent's own last words). Decision:
- Real interruption (>= 400 ms voiced and >= 2 confident words, or a stop word): stop playback within 200 ms, clear carrier buffer, mark the sentence as interrupted, do not resume it.
- Backchannel or noise: keep speaking.
- Ambiguous (voiced but no words yet): lower volume/hold the next chunk, do not clear; decide when words arrive.
- After a real interruption: drop the rest of the reply, and the next turn starts with the caller's words; the prompt gets a one-line note that the previous reply was cut after X, so the agent doesn't restart the same sentence and answers briefly.
- Deepgram: turn on interim barge-in by default, with the existing words/confidence gate. Sarvam: no interim text, so use VAD voiced duration (>= 400 ms, energy above the noise floor from the call's first seconds) as the early signal; this is a documented weaker path.

Per-call noise floor: measure the line's background energy during the first second and gate on a margin above it, so a steady noisy line doesn't keep tripping VAD (this is why "background noise makes it interrupt itself").

Targets: time to stop (`clearMs`) p50 <= 400 ms, p90 <= 800 ms on real interrupts; false interruptions (interrupt on backchannel/noise) <= 3% of agent-speaking turns; `interrupted` share on Sarvam from 47% toward <= 20% (also needs 4).

## 3. One thing at a time

Prompt and post-processing on the voice path: one question per turn, replies <= 2 sentences / 220 chars by default, lists over 3 items offered not read ("I have morning and afternoon, which do you prefer?"), `ch` p90 <= 160. Numbers and times in the language's convention (e.g. "ek baje", "quarter to five", phone numbers in groups of 3-4 with pauses), implemented in a speech-formatting step before TTS, with unit tests per language. Targets: reply chars p50 <= 90, p90 <= 160, max <= 240.

## 4. Pace and prosody

Evidence: Sarvam 20.4 vs Cartesia 15.8 chars/s. Mechanism: pace is resolved per language and provider so the *spoken* rate lands near a target (about 14-16 chars/s for English, calibrated per Indic language from measured playback), then the business's `speaking_rate` multiplies it. For Sarvam TTS that means sending `pace` below 1 by default (start 0.85-0.9, calibrate from the metric) and checking the voice/model choice per language (bulbul v3 speakers differ in speed). Sentence-level pauses: split TTS chunks at sentence ends with a 250-350 ms gap, and a slightly longer one before a question. Targets: speaking rate p50 14-16 chars/s on both providers; Sarvam within 15% of Cartesia.

## 5. Acknowledgement without dead air

Reuse PR #127's audio cache: a short acknowledgement ("Sure, let me check.") when a turn needs a tool or the first LLM phrase is not ready by 700 ms. Rules: never twice in a row, never more than one per turn, skipped when the first phrase is ready, rotated from a small set per language, cached per voice. Backchannel *while the caller speaks* ("hmm", "okay") is out of scope: it risks talking over the caller.

Targets: filler coverage on turns with first audio > 1.2 s: >= 90% (today 4 of 92 turns overall); the share of turns with > 1.5 s of silence <= 10% (today at least half).

## 6. Consistency and documented limits

One set of mechanisms (1, 2 and 5) behind an `STTCapabilities` descriptor (`interim: bool`, `endpointingControl: bool`, `wordTimestamps: bool`), so Deepgram and Sarvam run the same code with documented differences: Sarvam has no interim results, no endpointing parameter (settle time only), and no mid-sentence yield on words.

## Measurement

Existing columns cover: first-audio gap (`t_first_sent`), `clearMs`, interrupted share, `ch`, speaking rate, filler coverage, end reasons. Four small additions are needed (all nullable, off no behaviour): per turn `reply_overlap_ms` (agent first audio vs the last STT voiced timestamp), `caller_continued_after_reply_ms` (new caller speech within 1.5 s of the reply starting), the heard text length and confidence in the barge decision (no text stored), and the questions-per-reply count. The e2e simulator needs scenarios for each: overlap, pause mid-sentence, noise, backchannel, real interruption, slow speech; each PR ships its scenario and shows before/after. Observability read access would let us confirm the production baseline for the unmeasured items.

## STT option for Hinglish callers (evaluate, never switch automatically)

The Sarvam business runs Sarvam STT, which sends no interim text, so yielding on words can never be fast on that path (finding 1). Deepgram nova-3 in multilingual mode handles Hindi/English code-switching and sends interim results, so the interruption classifier works as designed. Trade-off to measure in the simulator and then on a pilot: yield time and false interrupts (better on Deepgram) against recognition accuracy on Indian-accented Hindi, Tamil and Telugu (Sarvam is built for these; Deepgram multilingual is weaker on them). It is a per-business setting (STT provider is already per business; Sarvam TTS can stay). Recommendation, to be confirmed with measured data: Deepgram multilingual for Hinglish-speaking callers on English/Hindi lines; Sarvam STT for Tamil, Telugu and other Indic lines.

## PR plan (approved order, small, one concern each)

1. Metrics: a safe per-decision descriptor (word count, confidence, voiced ms, word-list match, noise floor; no text) plus baseline scenarios (PR 134). 2. Pace and reply shape together: Sarvam `pace` set explicitly and calibrated to 14-16 chars/s, 2 sentences / 220 chars, one question, lists offered not read, Indian number and time speech. 3. Interruptions: InterruptionClassifier, clear within 200 ms, plus the Deepgram-multilingual option. 4. End-of-turn: EndOfTurnJudge; the Haiku classifier stays optional and off. 5. Acknowledgements on PR #127's cache. Each off by default per business, except the interruption fix on the Indian default set (to be agreed). Rebase on `claude/voice-experience` and #127 as they land; take the next free migration number when each PR opens.
