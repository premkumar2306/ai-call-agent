# Latency: what the caller actually hears

The server records a timeline for every turn (`GET /admin/calls/:callSid/turns`, p50/p90/p95 at
`GET /admin/latency`). Those numbers stop at the carrier's socket. This test measures the rest: a
recorder next to a real handset on a real call, compared turn by turn with the server's own numbers.

## What the server stamps mean

All times are ms from **t=0 = the moment the speech-to-text service reported the end of the caller's
speech** (`end_signal` says which signal: Deepgram `speech_final` / `utterance_end` / `stable`, Sarvam
`END_SPEECH`). That is *after* the endpointing wait (`DG_ENDPOINTING_MS`, default 250 ms), so the
caller finished speaking earlier than t=0.

| Field | Meaning |
|---|---|
| `t_final` | final transcript delivered (includes any hold for an unfinished sentence) |
| `tools[]` | each tool call: name, start, end, ok |
| `t_first_phrase` | first speakable phrase out of the model stream |
| `t_first_tts` | first TTS audio bytes received |
| `t_first_sent` | first audio frame written to the carrier socket |
| `t_playback_done` | **playback finished (carrier-confirmed)** |
| `t_first_filler_sent` | a "one moment" filler went out before the real reply (if any) |

**`t_playback_done` is not when the first sound became audible.** It is when the carrier told us it
had finished playing the reply's last chunk (Twilio `mark` echo, Exotel `mark` echo, Plivo
`playedStream` for the checkpoint we place after each chunk). It is null for an interrupted reply.
Neither it nor `t_first_sent` says when the caller first *heard* anything: carrier buffering and the
network sit between them and the handset. That gap is what this test measures.

Counters per turn: `stt_audio_s` (caller audio sent to STT since the previous turn began),
`tts_chars`, `reply_used_cached_audio` / `audio_cache` (always false/null today: the code has no
pre-rendered audio store, every greeting and filler is synthesized), `barge_in`, `stt_provider`,
`tts_provider`, `llm_model`. Each turn also logs one JSON line, `{"evt":"turn.timeline",...}`, for
`wrangler tail`.

## What you need

- A handset (phone A) to call the line, speaker on, **keypad tones on** (Settings → Sounds → Dial pad / Keypad tones).
- A recorder that hears phone A's speaker and the room: a second phone's voice memo app is fine. Put it
  20–30 cm from phone A, in a quiet room. Record at 16 kHz or better.
- A scripted caller: you reading the lines below, or the lines played from a laptop speaker into phone A.
- The operator key (`ADMIN_KEY`) and the API base URL.
- Node 18+. WAV recordings work as-is; MP3/M4A need `ffmpeg` installed (or convert to WAV first).
- A test business with `dtmf_input` off (the default), so the sync digit is ignored by the agent.
  Do not use `0`: it asks for staff.

## Procedure

1. Start the recording.
2. Call the line from phone A on speaker. As soon as the call connects, press **5** once. This is the
   sync marker: the server stamps the digit's arrival and the recorder hears the tone.
3. Let the greeting finish. Then say each line, and **stay silent until the reply has finished plus
   about 3 seconds** (do not talk over it; that would be a barge-in turn, not a latency turn):
   1. "Hi, I'd like to book an appointment."
   2. "Tomorrow morning, please."
   3. "The first one works."
   4. "Thank you, that's all."
   Say each line at a normal pace, in one breath, ending clearly (no trailing "um").
4. Hang up. Stop the recording. Wait about 10 seconds: the turn rows are written after the call.
5. Find the call and fetch its timeline:
   ```
   API=https://<your worker>      BUSINESS=<business key>
   SID=$(curl -s -H "X-Admin-Key: $ADMIN_KEY" $API/admin/transcripts/$BUSINESS | jq -r '.data[0].callSid')
   curl -s -H "X-Admin-Key: $ADMIN_KEY" $API/admin/calls/$SID/turns > turns.json
   ```
6. Run the comparison:
   ```
   cd worker
   node scripts/latency-from-recording.mjs /path/to/recording.wav ../turns.json
   ```
7. Repeat on each carrier (Twilio, Exotel, Plivo) and, if you can, on mobile and landline handsets.
   Five or more calls per carrier before drawing conclusions: one call is an anecdote.

## Reading the table

```
turn  heard ms  server ms  diff ms  endpointing  diff − endpointing
1     1180      610        570      250          320
```

- **heard**: the caller stopped speaking → the first audible sound of the reply, both measured in the
  recording (simple energy threshold, gaps under 300 ms bridged).
- **server**: the server's `t_first_sent − t_speech_end` for the same turn.
- **diff** = heard − server. It contains (a) the endpoint wait the server does not count, shown in the
  `endpointing` column when known, and (b) the carrier and network delay in both directions plus the
  handset's audio path. **diff − endpointing** is the best estimate of (b). It is an estimate:
  STT also takes a few ms after the endpoint, and the handset's speaker adds ~20–50 ms.
- A note instead of numbers means the script could not find that turn's caller speech or reply. It
  never guesses.

## How the alignment works, and where it can be wrong

The first DTMF tone in the recording is matched to the server's timestamp for that digit (`sync_dtmf_at`),
which maps each turn's server time onto the recording. That only picks *which* sound bursts belong to
which turn; the heard latency is measured entirely inside the recording, so a small alignment error
(the digit's own uplink delay, ~100–300 ms) does not change it.

Limits: it is an energy detector, not speech recognition. Room noise, the caller talking over the
reply, a reply that starts with a very quiet word, or speaker echo can produce a wrong burst; check
the note column and rerun in a quieter room. If a recording has no detectable DTMF tone, the script
says so and stops.

## Developer check

`cd worker && npx vitest run test/latency-from-recording.test.ts` generates a synthetic recording
(noise, a DTMF 5, two caller lines, two replies at known offsets) and checks the detection and the
per-turn numbers against it.
