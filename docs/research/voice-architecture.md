# Voice architecture: cascade vs realtime speech-to-speech

Short design note. Status: research, 2026-11-20. Anything not confirmed from a vendor page or from our own code is marked **UNVERIFIED**. The sandbox could only reach vendor pages through a search summary, and could not open the pricing pages themselves.

## What we have today

Carrier μ-law 8 kHz → STT (Deepgram, or Sarvam for Indic) → Claude (streamed, tool rounds) → TTS (Cartesia, or Sarvam) → carrier. All of it runs in one Durable Object per call (`CallRelay`). Our guardrails inspect text (`services/guardrails.ts`, the `emit()` filter in `turn.service.ts`), before it reaches TTS.

The "dead air" the owner hears is the cascade's cost: the caller waits for end of speech, then STT final, then the model's first token, then a tool, then the model again, then TTS time-to-first-byte. Our measured p50s are in the turn timeline (PR #119/#121). Simulator numbers are not production numbers.

## Comparison

| | Cascade (today) | Realtime speech-to-speech (OpenAI Realtime; Gemini Live) |
|---|---|---|
| **Latency / dead air** | Sum of 4 hops. Tools add a full model round. Fixable with fillers (PR A) but never below STT+LLM+TTS. | One model hears and speaks: vendors advertise sub-second turn latency. A tool call still pauses speech, but the model can say "let me check" itself in the same voice. UNVERIFIED for India (nearest region, PSTN jitter). |
| **Turn-taking / barge-in** | Ours: Deepgram/Sarvam endpointing + our mark-based "what was heard" tracking. Tunable, and we own it. | Server VAD in the vendor. Interruption cancels the model's response and truncates what it said; we must send the carrier `clear` ourselves. Less tunable, fewer moving parts. |
| **Tool calling** | Our tool router, rounds under our control, direct tool replies skip a model round. | Function calls over the socket. Same router works: receive `function_call`, run `executeTool`, send the output, ask for a response. Parallel/limits are the vendor's. |
| **Guardrails** | Text checked before any audio is made: price, booking claim, promise, ISO-date leaks, emergency, PII. | Audio is generated as text is. Transcript events arrive **after or alongside** audio, so a spoken sentence cannot be blocked before the caller hears it. What we can do: block tool calls that fail checks (before they run); run the text checks on the transcript and then correct out loud ("Sorry, I can't confirm that price"), cancel the response mid-sentence, and flag the call; constrain the model by prompt. A wrong price can be *spoken* and then corrected, which the cascade prevents. This is the biggest risk for clinics and law firms. |
| **Hindi / Hinglish / Kannada / Telugu / Tamil** | Sarvam is built for Indic and code-switching, with reviewed fillers/lines. | OpenAI and Gemini advertise Hindi; Kannada/Telugu/Tamil quality and Hinglish code-switching are **UNVERIFIED** and must be tested by native speakers before any claim. English-only for the prototype. |
| **Voice choice** | Any Cartesia voice, any Sarvam speaker, our own clones. | A fixed list of vendor voices (OpenAI: a handful of named voices; Gemini: a list). No Sarvam/Cartesia voices. Brand voice per business is lost. |
| **Carrier audio format** | Native μ-law 8 kHz both ways. | OpenAI Realtime documents `g711_ulaw` and `g711_alaw` as input/output audio formats next to `pcm16` (24 kHz), so Twilio/Plivo/Exotel μ-law passes through with no transcoding. Pass-through is **UNVERIFIED against the live API in this sandbox** (vendor docs only reached via search summary). Exotel sends PCM16 8 kHz, which needs a PCM resample (24 kHz) or μ-law encode: cheap, our adapter already converts. Gemini Live takes PCM16 16 kHz in / 24 kHz out: needs transcoding both ways (Worker CPU per frame). |
| **Inside a Durable Object** | One outbound WebSocket to STT plus HTTP to LLM/TTS per call. | One outbound WebSocket (`fetch` with `Upgrade: websocket`) to the vendor, replacing the STT socket and TTS requests. Fewer sockets than today. Works in a DO. Needs the DO to stay alive for the call (already true). |
| **Cost per minute** | ₹3.0–3.2/min (`docs/billing/cost-rates.md`; FX ₹88/$, carrier rates themselves UNVERIFIED). | OpenAI `gpt-realtime` audio: $32 / 1M input tokens, $64 / 1M output tokens, $0.40 cached input (vendor model page, via search; **UNVERIFIED**, not read at source). Caller audio is 1 token per 100 ms, assistant audio 1 token per 50 ms (OpenAI cost guide, **UNVERIFIED**). Per minute of conversation: input ≈ 600 tokens ≈ $0.019, output ≈ 1,200 tokens if the assistant speaks the whole minute ≈ $0.077; at ~45% speaking ≈ $0.035. Plus re-billed context each turn (cached rate helps) plus tool/text tokens. Estimate **$0.05–0.10/min ≈ ₹4.5–9/min** before carrier, i.e. **roughly 1.5–3× the cascade**. A "mini" model is advertised cheaper (third-party blog: $10/$20 per 1M; **UNVERIFIED**) with lower quality. Gemini Live: sources disagree (audio in $2.10–3.50 per 1M, ~25 tokens/s); **UNVERIFIED**. |
| **India data residency / DPDP** | Deepgram/Cartesia/Anthropic are US-processed today; Sarvam is India. We already ship a DPDP notice and retention controls. | OpenAI: audio streams to OpenAI (US, regional processing options exist for some regions; India region **UNVERIFIED**, likely none). Audio, not only text, leaves India, a heavier cross-border transfer for health/legal calls. Gemini on Vertex offers regional endpoints (Mumbai available for some models, **UNVERIFIED** for Live). Needs legal review before any real clinic. |
| **Lock-in** | Each stage swappable (we already swap STT/TTS per business). | The whole call quality (voice, turn-taking, language) sits with one vendor; swapping means re-tuning everything. Our tools, prompt and business profile stay ours, which limits the damage. |

## What the prototype in PR B does

Per-business `voice_pipeline: "cascade" | "realtime"`, default cascade. In realtime the DO opens one WebSocket to OpenAI Realtime (server VAD, `g711_ulaw` both ways), forwards carrier audio, sends model audio back to the carrier, runs Avery's tools through the same tool router, and runs our text checks on transcript events. English only. See that PR for what is blocked before audio and what is only corrected afterwards.

## Recommendation

1. **Stay on the cascade as the default.** It is the only option that can block a wrong price or booking claim *before* it is heard, it is cheaper (₹3.0–3.2 vs an estimated ₹4.5–9 per minute), it keeps Sarvam quality for Hindi/Hinglish/Kannada/Telugu/Tamil, and it keeps per-business voices. Those matter most to clinics and law firms in India.
2. **Fix dead air inside the cascade first** (PR A: cached fillers, immediate acknowledgement, tool-aware lines). This closes most of the *felt* gap for a fraction of the cost and risk.
3. **Keep realtime as a flagged experiment** for one English-speaking test business (a US or Indian-English line without a medical/legal price claim), to measure real turn latency and caller reaction. Before it goes near a real clinic: a native-speaker test of Hindi, the data-residency/DPDP answer for audio leaving India, and a decision on whether "spoken then corrected" guardrails are acceptable.
4. **Decide with data**: compare `speech_end → first audio` and cost per call on the test business against the cascade for two weeks. If realtime wins by a lot and guardrail misses stay at zero, widen it; otherwise drop it. Gemini Live is not worth prototyping until OpenAI's result is known (it needs 16/24 kHz transcoding in the Worker and has the same guardrail gap).

## To verify before relying on any of this

- OpenAI Realtime current model id, `g711_ulaw` in and out, per-token prices, regional processing (platform docs).
- Gemini Live model, price and region availability (Google pricing page).
- Hindi/Indic quality (native speakers, recorded calls).
- FX and carrier rates (already UNVERIFIED in `docs/billing/cost-rates.md`).
