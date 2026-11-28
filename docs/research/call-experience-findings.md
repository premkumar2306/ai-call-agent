# Call experience findings (Phase 1)

Status: draft for review. Evidence is from production D1 (`avery-platform`: `call_turn_metrics`, `call_outcomes`) plus a read of the code. Workers Observability logs were **not** available (403), so anything that needs STT timestamps or log lines is marked *not measured*. Call ids are the last 6 characters. No transcripts, names or numbers are in this file.

## What the data covers (and doesn't)

- 92 turns, 10 calls, one business (`jas_dental`), Twilio only, Sarvam STT on every call, none of them Indian carriers (Exotel/Plivo). Real calls in `call_outcomes` in the last 9 days: 8. The sample is small; treat percentages as directional.
- Sectors in production: 9 US (Deepgram + Cartesia), 2 India (Deepgram + Cartesia), 1 India (Sarvam STT + Sarvam TTS). `jas_dental` is the Sarvam/Sarvam one; its earlier calls (before the voice switch) used Cartesia TTS with Sarvam STT.
- 4 calls used Cartesia TTS (English voice), 6 used Sarvam TTS.
- No language column exists, so per-language splits are not possible. Per carrier: Twilio only.
- `t_speech_end` is 0 by construction: all `t_*` values are ms after the STT end-of-speech signal.

## Turn-taking: caller finished -> agent audio

| metric | p50 | p90 |
|---|---|---|
| STT end signal -> final transcript (`t_final`) | 933 ms | 996 ms |
| -> first LLM phrase | 1410 ms | 2201 ms |
| -> first audio sent to carrier (`t_first_sent`) | 1736 ms | 2484 ms |

Cartesia and Sarvam TTS are the same (1736 vs 1665 ms p50). Turns split in two groups: ~930 ms (`t_final`) and ~60-100 ms. The agent therefore takes about 1.7 s to start talking, which is slow for a human receptionist (~0.3-0.8 s) even before any overlap issue. Tools are not the cause: tool calls were p50 145 ms, p90 705 ms (check_availability 8, book_appointment 5, take_message 1 over 92 turns).

*Not measured:* replies that started while the caller was still speaking, and replies that started during a mid-sentence pause (needs STT word timestamps vs playback). Code evidence: endpointing is a fixed 250 ms on Deepgram, Sarvam has no endpointing setting, holds are 400 ms (complete statement of 4+ words) and 900 ms (incomplete-looking), and Hindi/Hinglish counts as incomplete only when it ends on a dangling word.

## Interruptions

- 37 of 92 turns had barge-in; **22 turns ended `interrupted`** (24%). Cartesia: 1 of 47. **Sarvam TTS: 21 of 45 (47%)**. One Sarvam call (`8a3baa`) was interrupted on 14 of 18 turns.
- Barge-in decisions: 48 decisions, 21 interrupts. Reasons for the interrupts: enough_words 15, final transcript 6. Skipped: too_few_words 7, backchannel 2, echo 1. Stop-word, low-confidence and VAD triggers: none recorded.
- **Time to stop (`clearMs`, caller first signal -> agent cleared):** 0 ms in 5 cases, **754-4140 ms in the other 16 (median about 2.4 s)**. In those 16 cases the agent kept speaking over the caller for seconds. `playedAfterClear` was 0, so once cleared it stopped cleanly. Interim barge-in is off by default, and Sarvam sends no interim text, so the agent can only yield after a final transcript.
- False interruptions (noise/backchannels cutting the agent off): only 3 skipped-decision events are visible (backchannel/echo), and none of the 21 interrupts is labelled noise. The "interrupts itself on noise" complaint is *not confirmed or refuted* by this data; the barge-in log does not record the heard text or whether the speech was addressed to the agent.
- Replies withdrawn: `interrupted` 22, `dropped` 1.

## Pace and sentence shape

- Speaking rate = reply characters / seconds of playback (`tts_chars` / (`t_playback_done` - `t_first_sent`), turns over 40 chars, not interrupted; this includes inter-chunk gaps, so it is a lower bound): **Cartesia p50 15.8 chars/s (n=27); Sarvam p50 20.4 chars/s (n=20), p90 22.6**. Sarvam is about 30% faster and runs at its default pace (`pace` is only sent if set). This matches "speaks too fast", and the Sarvam calls are the ones callers talk over.
- Reply length: p50 106 chars, p90 191, max 367 (a single-turn 367-char reply on `fa517c`; the caller hung up after 13 s).
- Questions per turn and list reads: not stored. The prompt caps replies at one question and about 35 words on the voice path, but nothing stops a long list.

## Silence and fillers

- Fillers played on 4 of 92 turns (all at about 2.3 s). Dead air: every turn has >= 0.9 s before the first audio and p90 2.5 s; with a tool, p90 first audio is similar. `cached_audio` was 0 on all turns (the filler cache is in PR #127, not merged).

## Endings

- `end_reason` (6 calls with the field): caller_hangup 6; 2 older calls have none (one lasted 3592 s: pre-guard). No `max_duration` cap hits, no silence or error endings.
- Hangup confirmation: all 4 recorded `hangup_confirm_ms` are 5042-5070 ms, method `callback`. That is suspiciously constant, so it looks like the fixed wait rather than a real confirmation from the carrier. Worth checking in the termination work, not in this one.

## Five worst calls (turn by turn, anonymised)

1. `8a3baa` (Sarvam TTS, 89 s, 18 turns): 14 interrupted. Turns 1-3, 5-8: agent started at 1.8-2.4 s, caller began speaking while it talked, and it stopped 0.75-2.5 s later. Turns 9, 10, 12, 14, 17 were stopped by the final transcript 1.7-4.0 s after the caller began, so the agent talked over a full caller sentence. Only 4 turns played to the end.
2. `616fd0` (Sarvam, 36 s, 6 turns): turns 2, 4, 5 interrupted; turn 2 replied at 2.9 s and was cut by "enough words".
3. `fa517c` (Sarvam, 13 s, 1 turn): first audio at 2.5 s, 367 characters; the caller hung up.
4. `8bb3e5` (Sarvam, 13 s, 1 turn): first audio at 2.3 s, 142 characters; caller hung up.
5. `508608` (Sarvam, 112 s, 10 turns): 2 interrupted; median first audio 1.75 s.

## Top 5 root causes (ranked by impact on "feels human")

1. **The agent only yields after the caller has said a lot.** 16 of 21 interrupts took 0.75-4.1 s to clear (median about 2.4 s), because interim barge-in is off and Sarvam has no interim results. Evidence: `clearMs` above; code `handleSpeechStart`. Human yield time is about 0.2-0.5 s.
2. **Sarvam path is too fast and gets talked over.** 20.4 vs 15.8 chars/s; 47% of Sarvam turns interrupted vs 2% on Cartesia. Pace is never set.
3. **Slow, timer-based reply start.** First audio p50 1.7 s, p90 2.5 s, with ~0.9 s of that waiting on STT finalisation and holds that are fixed timers, not what was said. This invites both overlap (reply starts into a pause) and dead air.
4. **Replies are long, with no pauses.** p50 106 chars, max 367, no list limit on the voice path; long replies are what get interrupted.
5. **No acknowledgement before slow turns.** Fillers on 4 of 92 turns, no cached audio, so the agent is silent for 1-2.5 s after every question.

Not yet measured (needs Observability or new fields): overlap (reply while the caller speaks), pause-then-continue rate, noise-triggered self-interruptions, per-language splits, questions per turn.
