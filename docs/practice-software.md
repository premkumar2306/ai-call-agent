# Practice software: Practo, Clinicia, Eka

Clinics keep their diary in practice software (or on paper). Avery doesn't write into any of
them. What's supported, exactly:

| Software | Public, documented API? | Calendar export? | What Avery does today |
|---|---|---|---|
| **Practo Ray** | **No public API found.** A directory listing says Ray has no API ([SaaSworthy](https://www.saasworthy.com/product/ray-by-practo)). Third-party "integration guides" describe a partner API at api.practo.com, but they're unofficial and the endpoints are placeholders. Access would have to come from Practo directly. | Not documented publicly. If the clinic's Ray account offers an iCal/Google Calendar feed, use it (ICS row below). | Front-desk confirmation mode. ICS import if the clinic has a feed. |
| **Clinicia** | **No public API found** (searched for a developer documentation site and listings; nothing official). | Not documented publicly. | Front-desk confirmation mode. ICS import if the clinic has a feed. |
| **Eka Care** | **Yes, a documented developer API** ([developer.eka.care](https://developer.eka.care/api-reference/doc-tool/appointment-api/getting-started)): appointment slots, booking and appointments by date; plus a JS SDK and an MCP server. It needs client credentials from Eka. The published endpoint paths differ between pages ([slots reference](https://developer.eka.care/api-reference/doc-tool/appointment-api/get-appointment-slots)). | — | Front-desk confirmation mode. **No Eka adapter yet:** it should be built against a sandbox account with credentials, once the endpoint paths are confirmed with Eka (ekaconnect@eka.care). Until then, nothing calls Eka. |
| **Any software with an iCal / ICS feed, or Google Calendar** | — | ICS (RFC 5545) or Google Calendar | **Read-only availability import** (below), or the existing Google Calendar connection (Calendar page), which already blocks busy times. |

Research date 16 Nov 2026 (web search; docs.plivo.com and docs.sarvam.ai were unreachable from
this session, the vendor sites above were not opened directly, so recheck before telling a clinic
"supported"). **Avery never scrapes or uses an undocumented API.**

## The safe default: front-desk confirmation mode

Per business, off by default: Settings → Business → **Practice software** → "Front desk confirms
each booking" (needs the front desk's mobile). `PUT /practice/:business { confirmationMode: true, frontDeskPhone }`.

1. Avery takes the request on the call (or WhatsApp) as usual. The booking is saved as
   **PENDING** with `front_desk_status = pending`, so the slot is held.
2. The caller hears: *"I've sent your request for Cleaning for tomorrow at 10:30 am to the clinic.
   It's pending until the front desk confirms it — you'll get a message as soon as they do."* The
   patient also gets a "pending" SMS when SMS is set up. No "you're booked" message is sent.
3. The front desk gets an SMS (plus an email to the business's notification address) with a link:
   `https://<worker>/fd/<token>` (`WORKER_URL`, else the Plivo/Twilio webhook base). The page
   shows the patient, service and time, a **Confirm** button and a **Suggest another time** picker.
   Opening the page changes nothing, so link previews in WhatsApp or SMS apps can't confirm by
   accident. Only the buttons (POST) do.
4. **Confirm** sets the booking CONFIRMED, and the patient gets the normal confirmation (WhatsApp
   template or SMS). **Suggest** records the time and texts the patient to reply or call to accept.
   The front desk then enters the booking in their own software, as they do today.

The token is 48 random hex characters, stored on the booking and never reused.

## Read-only availability import (ICS)

Per business, off by default: paste the software's calendar feed (https:// or webcal://), then
tick "Use its busy times". `PUT /practice/:business { icsUrl, icsImport: true }`;
`POST /practice/:business/ics/sync` imports now. The hourly cron refreshes it.

- Busy times for the next 14 days are cached in KV (3-hour TTL). They block slots in
  check_availability and in the booking-time re-check, exactly like Google Calendar busy times.
- Parsed: VEVENT with DTSTART + DTEND or DURATION, UTC (`Z`), `TZID=` and all-day dates.
  Skipped: `STATUS:CANCELLED`, `TRANSP:TRANSPARENT`.
  **Not supported:** recurring rules (RRULE): only the first occurrence counts. Most practice
  diaries export one event per appointment, but check the feed.
- Only an `https://` URL; at most 2 MB; 8-second timeout. The URL often contains a private token,
  so the UI never shows it back (only its host).
- Nothing is ever written to the feed or the software.

## Checks

- Unit: `worker/test/practice.test.ts` (ICS parsing, sync + busy merge + booking re-check, front-desk
  request, GET changes nothing, confirm, suggest).
- e2e: `npm run e2e -- practice`. A simulated call is told "pending", the front desk gets the
  link, opening it changes nothing, Confirm confirms and notifies the patient, and an ICS feed
  marking today busy moves the booking to tomorrow.
