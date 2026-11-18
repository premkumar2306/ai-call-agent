# Conversation guardrails

What the assistant may say and do. One layer, `worker/src/services/guardrails.ts`, with every keyword list in
`guardrail-keywords.ts`. It is **off by default per business** (`sectors.guardrails`, migration 0027), so the existing
US business is unchanged. Turn it on or off: `PUT /admin/guardrails/:business {"enabled": true}`.
Flags for Operator → Calls: `GET /admin/guardrails/:business[?callSid=…]` lists the events
(`emergency`, `self_harm`, `abuse`, `injection`, `pii`, `advice`, `blocked_price`, `blocked_booking`, `blocked_promise`).
An event stores the kind and a short label, never the caller's words.

## Rules

| Rule | Prompt | Code | Test |
|---|---|---|---|
| a. Emergency → 112 (India) / 911 (US), staff offered, no booking | yes | Fixed reply, no model call; `book_appointment`/`check_availability` refused for the rest of the call | `guardrails.test.ts`, `guardrails-turn.test.ts`, e2e (Hindi) |
| b. No medical/legal advice, no guaranteed outcome | yes | Advice requests get a per-vertical redirect (clinic, dental, legal, general); outcome promises in the assistant's text are blocked | same, e2e (dental) |
| c. Facts: prices only from the catalog or a tool result; bookings only after the booking tool succeeded | yes | An unsupported amount or an unbacked booking claim is dropped before it is spoken and corrected | same, e2e (price, booking claim) |
| d. Injection / role abuse / other people's data | yes | Fixed refusal, no model call, flagged. Booking tools already scope to the caller (`getOrder(…, token.sub)`, `getOrders(…, token.sub)`) | same, e2e (injection) |
| e. Abuse: one warning, then polite end, flagged. Self-harm: helpline + staff | yes | Fixed replies. Second abusive turn sets `cache.endCall` (see "Open item") | `guardrails-turn.test.ts` |
| f. PII: don't ask for or keep card numbers, Aadhaar, OTPs | yes | Redacted before the model, history, transcript and logs; fixed reply | all three, e2e (card number) |
| g. Consent: DPDP notice plays before data is collected | n/a | Existing (`disclosure.ts`, CallRelay) | `guardrails.test.ts` (notice exists per language), existing e2e "notice is spoken before the greeting" |

Helplines: India emergency 112, Tele-MANAS 14416 (self-harm); US 911, 988. Country comes from the business
(`isIndianBusiness`). Keyword lists cover English, Hindi, Hinglish, Kannada, Telugu and Tamil; the Dravidian and
Hindi lists are first drafts, not reviewed by native speakers. Replies are in English, Hindi or Hinglish (by the
caller's words, else the line's language); Kannada, Telugu and Tamil callers get English.

## Audit of what existed before

| Rule | Where | Test |
|---|---|---|
| Clinic: no medical advice or diagnosis; emergencies → 112, stop booking, offer staff | `verticals.ts` CLINIC `extra` (prompt only) | prompt snapshot only, no behaviour test |
| Legal: no legal advice, no promotion, urgent matters → staff | `verticals.ts` LEGAL `extra` (prompt only) | `legal.test.ts` |
| Never invent facts, prices or policies | `verticals.ts` `unknownRule` per vertical (prompt only) | none |
| Never say a booking/transfer/message is done before the tool succeeds | `turn.service.ts` `buildAgentRules` (prompt only) | none |
| Only offer/book times `check_availability` returned | `turn.service.ts` prompt; `tool-router` validates the slot in `book_appointment` | `clinic.test.ts`, `logic.test.ts` |
| Reasoning (ISO dates) never spoken: chunk dropped | `turn.service.ts` `emit` (code) | `agent.test.ts` |
| Always admit to being an AI if asked | `turn.service.ts` prompt | none |
| health_nav: urgent clinical → act immediately | `turn.service.ts` prompt (prompt only) | none |
| Classifier flags crisis / emergency at end of call (`compliance_flags`, `urgency`) | `call-classifier.service.ts` (after the call; `getCrisisResponse` is not called anywhere) | none |
| Caller sees only their own bookings | `tool-router.service.ts` `getOrder`/`getOrders` keyed by caller hash | none |
| DPDP notice before data | `disclosure.ts`, CallRelay | `compliance.test.ts`, e2e |

## Open item

The abuse "polite end" sets `cache.endCall = true` after the goodbye line, but `call-relay.ts` does not read it yet
(another change owns that file). Until it does, the caller hears the goodbye and the call ends on the existing
silence timeout. The hook is a few lines: when a turn finishes and `cache.endCall` is set, treat it like
`hangupWhenDone`.

## Limits

- Amounts are checked as digits with a currency marker (₹, Rs, rupees, $, dollars, रुपये). A price spoken in words
  ("five thousand rupees") is not caught.
- The checks run per spoken chunk; a claim split across two sentences is not caught.
- Card numbers and OTPs the speech recogniser writes as words are not redacted.
- Code checks run in `runTurn` (phone) and in `whatsapp.ts` (same detection and redaction; the fact check runs on the
  whole reply instead of per chunk). After an emergency on WhatsApp the booking tools are not blocked, only the prompt
  says so. The browser voice test (`mogi.ts`) gets the prompt rules only (internal demo).
