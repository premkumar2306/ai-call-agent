# Research: where LiveKit fits

Date: 2026-11-19. Research only; no production code changed.

## How this was sourced (read first)

`docs.livekit.io`, `livekit.io`, `livekit.com` and `www.plivo.com` do not resolve from the research sandbox
(not on its network allow-list), and the Plivo CLI install was refused by the session's permission check, so
`plivo docs show ...livekit` was **not run**. Everything below comes from web-search summaries of those pages
(URLs listed per claim) plus our own repo. Anything not seen on an official page is marked **UNVERIFIED**.
No price is guessed; a missing price is stated as missing.

## Recommendation

Do not move calls onto LiveKit, and do not migrate the agent. For Indian numbers it would add a second
vendor, a fixed monthly plan, a long-running agent process we would have to host, and a region-pinning
dependency, in exchange for latency and quality gains nobody has measured on our calls. Avery already has
barge-in, DTMF, reconnects, guardrails and a per-turn timeline, and runs on Workers with nothing to operate.
The one idea worth a cheap look is **option 3, LiveKit's open end-of-turn model, in shadow mode**, to see
whether it lets us lower `DG_ENDPOINTING_MS` (250 ms today) without cutting callers off. Run the one-week PoC
below; if it misses the bar, drop LiveKit entirely. Option 2 (browser WebRTC) gains almost nothing today
because the "Try your assistant" path is not a stream.

## Facts that decide it

- Today's browser tester (`worker/src/routes/mogi.ts`) is **per-turn REST** (`POST /mogi/transcribe`,
  `POST /mogi/tts`; the browser holds the conversation), not a WebSocket. There is no live stream to replace.
- LiveKit Agents (Python / Node) are long-lived worker processes that register with a LiveKit server and
  accept dispatched jobs ([JS agents repo](https://github.com/livekit/agents-js)). They do not run on Workers
  (inference from the model above, not a stated LiveKit position). So options 1 and 4 mean running servers.
- Avery's STT stack already has end-of-turn signals: Deepgram `speech_final` / `utterance_end`, Flux
  (`call-relay.ts` skips fixed endpointing when Flux is on), Sarvam `END_SPEECH`.
- The turn-detector model needs ~400 MB RAM and ~25 ms per inference on CPU (vendor figure, hardware not
  stated) ([PyPI plugin](https://pypi.org/project/livekit-plugins-turn-detector/1.5.1/)). A Worker has far less
  memory, so it cannot run in a Worker; it needs a small container or VM next to the Worker.

## Options table

Scores: + better than today, = same, − worse, ? unknown. Evidence in the sections after the table.

| Criterion | 1. LiveKit SIP + Agents + Plivo Zentrunk (India) | 2. LiveKit WebRTC for browser tester | 3. Borrow turn model / noise cancel only | 4. Full migration to LiveKit Agents | 5. Keep current stack |
|---|---|---|---|---|---|
| Time to first audio | ? Unmeasured. An extra SIP hop and an agent process in `ap-south`; LiveKit's detector claims fewer false cut-offs but TTFA is dominated by LLM + TTS ([Deepgram blog](https://deepgram.com/blog/evaluating-end-of-turn-detection-models)) | = | + possible: lower endpoint wait if detector allows it; adds a network hop (~tens of ms, UNVERIFIED) | ? same as 1 | Measured: PR #119 timeline, handset test |
| Turn detection | + vendor claims 4.5% vs 9.9% false cut-off for Flux at 600 ms (LiveKit's own benchmark) ([summary](https://www.besthub.dev/articles/livekit-turn-detector-v1-beats-deepgram-flux-and-makes-turn-detection-measurable-aca99143f150)); Hindi listed among 14 languages | = | + same model, needs transcript text; Sarvam path would need interim text | + | = Deepgram endpointing 250 ms, Flux, Sarvam END_SPEECH |
| Call quality | ? Opus/WebRTC inside LiveKit, but the PSTN leg is still µ-law 8 kHz; BVCTelephony noise cancellation for SIP exists | = | ? noise cancel: Krisp BVC reported "Cloud only" by staff, but Node plugin supports own Krisp licence ([thread](https://community.livekit.io/t/noise-cancelling-features-with-self-hosted-agents/1227)); licence terms UNVERIFIED | ? same as 1 | = known; no noise cancellation on the carrier leg |
| India compliance | − extra moving part: must use `india` SIP endpoint, pin region, agents in `ap-south`, and LiveKit region pinning (one doc says Scale plan or higher; another says enable via Support) | = no PSTN | = if the service is hosted in India | − as 1 | = media stays on Plivo/Exotel India routing today (confirm per carrier) |
| Cost per minute | See cost section: +₹0.07–0.60 telephony, + fixed plan fee | no price found (UNVERIFIED) | a small always-on container (no price quoted) | as 1 + hosting | ₹1.73–2.43 (repo `docs/pricing.md`) |
| Operational burden | − agent worker fleet, autoscaling, LiveKit Cloud or self-hosted SFU + SIP | − | − one small service | − highest | + zero servers |
| Migration effort | High: new call path, rework `call-relay.ts` (DTMF, guardrails, reconnect, timeline, billing usage) | Medium, no user benefit | Low: shadow call from the DO | Very high: rewrite in Python/Node | none |
| Lock-in | Medium–high (LiveKit SIP, dispatch, plugins); Apache-2.0 SDK but detector weights under LiveKit Model License | Medium | Low–medium (weights licence) | High | Low: each vendor swappable |
| What we'd lose | Exotel and Twilio paths (carrier WebSockets), serverless ops, pipeline we control | Per-turn simplicity | nothing | everything in `call-relay.ts` | — |

## India compliance

- Plivo: calls to or from Indian numbers must have SIP and media terminating in India, otherwise they hang up
  with **4590** ("India media anchoring violation"); fix is to put the media-handling server in India
  ([Plivo hangup codes](https://plivo.com/docs/voice-agents/sip-trunking/troubleshooting/hangup-codes),
  [Plivo India guide](https://plivo.com/docs/voice-agents/sip-trunking/deploy/calling-in-india)). Plivo's
  LiveKit guide says to select India as the LiveKit region for India calls, or calls fail
  ([Plivo LiveKit guide](https://docs.plivo.com/docs/sip-trunking/Livekit)).
- LiveKit Cloud: Mumbai is `ap-south`. SIP needs the regional hostname
  `{sip_subdomain}.india.sip.livekit.cloud`; agents are assigned a region at creation and it cannot be changed;
  region pinning covers network traffic only ([region pinning](https://docs.livekit.io/telephony/features/region-pinning.md),
  [agent regions](https://docs.livekit.io/deploy/admin/regions/agent-deployment.md)).
- Open questions, all **UNVERIFIED**: whether pinning needs the Scale plan; whether LiveKit Inference and model
  providers are covered by pinning (a [community thread](https://community.livekit.io/t/data-residency-for-deepgram-stt-when-using-livekit-inference-in-india-region/1203)
  says this is not explicit); whether our own Deepgram/Cartesia/Anthropic calls from an India agent are in scope
  of whatever rule Plivo is enforcing (Plivo's rule concerns the call media path).
- Incident note: LiveKit status page lists a 2 Jun 2026 incident with SIP call failures in the India region
  (~40 min), resolved ([status](https://status.livekit.io/incidents/616ks8lp2mm2)).
- DPDP: moving audio and transcripts to another processor (LiveKit) would need to be reflected in the privacy
  notice and `docs/compliance-india.md`. Not legal advice.

## Cost per minute, typical clinic (300 calls × 2 min = 600 min/month)

Current numbers come from `docs/pricing.md` / `DEFAULT_COST_RATES` (₹88/USD, list prices). LiveKit and Plivo
figures come from search summaries dated 2026-11-19 and must be re-checked on the official pages.

| Line (per minute unless stated) | Current (Plivo/Exotel + Deepgram + Cartesia) | Option 1/4 (LiveKit Cloud + Plivo Zentrunk + same STT/TTS/LLM) |
|---|---|---|
| Phone line | $0.006 ≈ ₹0.53 (placeholder in repo, not an invoice) | Plivo India ₹0.60 local number, in and out; another Plivo page says ₹0.40; conflicting, UNVERIFIED ([Plivo pricing](https://www.plivo.com/sip-trunking/pricing/in/)) |
| LiveKit usage | none | Agent session $0.01/min beyond plan allowance; third-party SIP $0.004/min beyond allowance ([pricing summary](https://livekit.com/pricing.md)). 600 min fits inside the Ship allowances (5,000 each) |
| STT + TTS + LLM | ₹2.43 − ₹0.53 = ₹1.90 (English); Hindi ₹1.20 | unchanged ₹1.90 / ₹1.20 if we keep our vendors; LiveKit Inference prices not found |
| Per-minute variable total | ₹2.43 English, ₹1.73 Hindi | about ₹2.50 English (₹0.60 + ₹1.90), about ₹1.80 Hindi |
| Fixed plan | none | Ship **$50/mo** (≈₹4,400), or Scale **$500/mo** (≈₹44,000) if India pinning needs it (UNVERIFIED) |
| Agent worker hosting | none | not priced, UNVERIFIED (any VM or container fleet we run) |
| **Month, one clinic (600 min), English** | **≈₹1,458** | **≈₹1,500 + ₹4,400 = ₹5,900 on Ship (≈₹9.8/min); ≈₹45,500 on Scale (≈₹76/min)**, plus hosting |
| Same, if the plan fee is shared by 25 clinics | | Ship ≈ +₹176/clinic, Scale ≈ +₹1,760/clinic (≈₹2.9/min) |

Option 2: LiveKit WebRTC participant-minute price not found; Cloudflare's alternative SFU is $0.05/GB egress,
first 1,000 GB free ([Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/index.md)),
which would round to zero at tester volumes. Option 3: the end-of-turn model is free to download (LiveKit Model
License); cost is one small always-on instance, unpriced here. Noise cancellation: listed as included on every
plan with no separate rate found, **UNVERIFIED**.

## Risks

1. **Region/compliance fragility.** One missed pin or a non-India agent region produces 4590 hangups on live
   clinic calls; pinning may need the $500 plan and may not cover inference providers.
2. **Fixed cost and ops against a serverless, low-margin model.** ₹4,400–44,000/month fixed plus servers,
   against clinics paying ₹4,999/month with a 61% margin worst case.
3. **Rewrite risk.** Barge-in, DTMF, reconnects, guardrails, the timeline and billing usage all live in
   `call-relay.ts`; a migration would regress each and delay roadmap work.
4. **Vendor benchmark numbers.** The detector comparison is LiveKit's own; endpointing settings can dominate
   (a community report traced 600 ms+ delay to the 0.5 s default) ([thread](https://community.livekit.io/t/high-latency-of-turn-detection/1275)).
5. **Licensing.** Detector weights are under the LiveKit Model License, not Apache; Krisp terms unclear.
6. **Hindi/Hinglish accuracy** of the detector on real clinic audio is unproven (vendor card: 99.4% TPR on Hindi).

## What the current stack does better (option 5)

Zero servers; one deploy; works on Twilio, Exotel and Plivo with the same code; carrier-confirmed playback
(`t_playback_done`) and a per-turn timeline we already trust; Sarvam Indic STT/TTS path; barge-in, DTMF,
guardrails and billing integrated; vendors swappable; nothing extra to configure for India.

## One-week proof of concept (option 3 only, shadow mode)

Goal: can the LiveKit end-of-turn model let us wait less than 250 ms without cutting callers off?
No change to what callers hear; the model only logs a decision.

| Day | Work |
|---|---|
| 1 | Baseline: 5+ handset calls per carrier per `docs/latency-handset-test.md`; record `speech_end_to_first_sent` p50/p90 (PR #119, `GET /admin/latency`) and `heard` / `diff − endpointing` per turn. |
| 2 | Run the multilingual turn-detector ONNX model in a throwaway container in an India region (`spikes/livekit/` only); measure inference p50/p95 on CPU. |
| 3 | Offline replay: feed the logged interim/final transcripts from ≥200 real turns (English and Hindi/Hinglish) and compare its end-of-turn call to what Deepgram/Sarvam decided; hand-label mismatches. |
| 4 | Shadow call from a test business's Durable Object (flag off for everyone else, `ADMIN`-only): log detector verdict and RTT beside `t_final`; callers unaffected. |
| 5 | Re-run handset test with `DG_ENDPOINTING_MS` lowered (e.g. 150) gated by the detector, on the test line only. |
| 6–7 | Analyse; write go/no-go. |

**Success bar** (all must hold, else stop):
- `heard` latency p50 improves by ≥150 ms vs day-1 baseline on both Deepgram English and Sarvam Hindi turns.
- False cut-offs (caller resumed within 2 s of a reply starting, or a barge-in on the first reply) are not
  higher than the day-1 baseline, on ≥200 turns.
- Detector round trip from the Worker adds ≤50 ms at p95; `speech_end_to_first_sent` p90 does not regress by
  more than 50 ms.
- Always-on service cost under ₹3,000/month, or amortised under ₹0.15/min across expected minutes.
- No audio or personal data leaves India for the detector (transcript-only input, India-hosted).

Out of scope by design: LiveKit SIP, Agents, Cloud, or any carrier change.
