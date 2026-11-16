# Overflow-only pilot on the clinic's existing number

The clinic keeps its number and its staff answer first. When the line is **busy**, **nobody
answers** or the phone is **unreachable**, the clinic's carrier forwards the call to the clinic's
Avery number (conditional call forwarding). Patients never need a new number, and the clinic can
stop the pilot by cancelling the forward.

## What Avery does

| | |
|---|---|
| Pilot switch | Per business, off by default: Settings → Phone → **Overflow pilot** (start date, end date, clinic number, line type). API: `GET/PUT /pilot/:business`. Stored in `pilot_configs` (migration 0023). |
| Overflow tag | Every call reaching the Avery number while the pilot is on (dates inclusive, business time zone) is written to `call_routing` with `is_overflow = 1`. In an overflow-only pilot the Avery number isn't published, so a call can only arrive by forwarding. |
| Forwarding number | Captured when the carrier sends it: `reason = carrier_forwarded`, `forwarded_from = +91…`. Without it: `reason = pilot_overflow`. |
| Test your forwarding | Settings → Phone → **Start test**, then call the clinic number from another phone and don't pick up. The first call that reaches Avery within 15 minutes completes the test and shows whether the carrier identified the clinic's number. API: `POST/GET /pilot/:business/forwarding-test`. |
| Without a pilot | Nothing changes. A call is recorded in `call_routing` only if the carrier itself marks it as forwarded. The US business has no pilot and is untouched. |

### What each carrier sends

| Carrier | Field | Status |
|---|---|---|
| Plivo | `ForwardedFrom` on the Answer URL request | Listed among Plivo's voice request parameters ([Plivo XML request docs](https://docs.plivo.com/docs/voice/xml/request)). Value depends on the forwarding network. The e2e simulator sends it. |
| Twilio | `ForwardedFrom` on the incoming-call webhook | Twilio: set only when it receives a forwarded call, and the value depends on the caller's carrier ([Twilio voice webhook parameters](https://www.twilio.com/docs/voice/twiml#request-parameters)). |
| Exotel | `ForwardedFrom` | Exotel lists it as a **deprecated** passthru parameter that applications should not rely on ([Exotel passthru applet](https://docs.exotel.com/voice-apis/working-with-passthru-applet)). Avery reads it only if present; on Exotel the overflow tag comes from the pilot dates. |

Indian networks often don't pass the original forwarding number through. That's why the pilot
tags by dates and doesn't depend on `ForwardedFrom`.

## Forwarding codes

Dial from the **clinic's phone**. Replace `AVERY` with the Avery number shown in Settings → Phone.
Use **conditional** forwarding (busy / no answer / unreachable), never "forward all calls", or
staff won't get to answer first.

**Treat every code below as "verify with carrier" until it has been tried on a real line.** The
sources are third-party guides and the 3GPP standard. None of the Indian operators publishes a
code table we could check, and the guides disagree on some codes.

### Jio (VoLTE)

| Condition | Activate | Cancel | Confidence |
|---|---|---|---|
| Busy | `*405*` + 10-digit number | `*406` | Consistent across guides ([91mobiles](https://www.91mobiles.com/hub/call-forwarding-codes-jio-airtel-vi-bsnl-how-to-activate/), [TelecomTalk](https://telecomtalk.info/how-to-start-and-stop-call-forwarding/493353)); verify with Jio |
| No answer | `*403*` + 10-digit number | `*404` | Same sources; verify with Jio |
| Unreachable | sources disagree (`*409*` / `*403*`) | `*410` | **Verify with Jio.** Prefer the MyJio app: Profile → Mobile Settings → Service Settings → Call Forwarding ([TelecomTalk](https://telecomtalk.info/jio-now-users-manage-call-forwarding-myjio/1004442/)) |

Jio's own FAQ confirms that busy and no-answer forwarding exist, but doesn't list codes
([Jio FAQ](https://jio.com/help/faq/mobile/services/hd-voice/what-are-different-types-of-call-forwarding)).

### Airtel, Vi, BSNL (GSM codes)

These are the standard GSM supplementary-service codes (3GPP TS 22.030). Airtel's own blog points
to the Airtel Thanks app's Call Diversion screen as the reliable route
([Airtel blog](https://www.airtel.in/blog/airtel-thanks-app/divert-calls-in-airtel/)).

| Condition | Activate | Cancel |
|---|---|---|
| Busy | `**67*AVERY#` | `##67#` |
| No answer | `**61*AVERY#` (optionally `**61*AVERY**15#` for 15 s ring time; verify) | `##61#` |
| Unreachable | `**62*AVERY#` | `##62#` |
| All three conditional at once | `**004*AVERY#` | `##004#` |
| Check status | `*#67#`, `*#61#`, `*#62#` | |

Status: Airtel: busy/no-answer/unreachable codes match third-party guides
([91mobiles](https://www.91mobiles.com/hub/call-forwarding-codes-jio-airtel-vi-bsnl-how-to-activate/)); **verify with Airtel**.
Vi and BSNL: standard GSM codes, **verify with carrier**. Use `AVERY` with the country code
(`+9180…`) or as the carrier's guide says.

On most Android and iPhone handsets the same settings are in Phone → Settings → Calls → Call
forwarding, which sends these codes for you.

### Landlines

- **BSNL/Airtel/Jio Fiber landlines:** forwarding codes depend on the exchange and plan. Ask the
  provider to turn on "call forward on busy" and "call forward on no reply" to the Avery number.
  **Verify with carrier.**
- **EPABX in the clinic:** set the extension's "forward on busy / no answer" to an outside line
  dialling the Avery number (needs a free trunk line).

### IVR / cloud PBX (Exotel, MyOperator, Knowlarity, Tata Tele…)

Set the **fallback** of the "connect to staff" step (busy / no answer / after N seconds) to dial the
Avery number. No carrier code is needed, and the IVR keeps its own reports. If the clinic's IVR
is itself on Exotel, a Connect applet to the Avery ExoPhone works too.

## Checklist for a pilot

1. Avery number connected (Settings → Phone) and a test call to it works.
2. Settings → Phone → Overflow pilot: clinic number, line type, start and end dates, **Pilot on**,
   then Save.
3. Set conditional forwarding on the clinic line (above).
4. **Start test**, call the clinic number from another phone, and reject or don't pick up. The test shows
   **Forwarding works**.
5. Tell staff: answer as usual. Missed calls are now handled.
6. At the end date the tag stops automatically. Cancel the forward (`##004#` / `*406`, `*404`) if the
   clinic doesn't continue.
