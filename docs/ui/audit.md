# Admin UI audit (before the cleanup)

Screenshots of every screen were taken at 1280px and 390px for owner and operator;
a few are kept in `docs/ui/before/`.

What makes the current admin app confusing:

1. **Ten to twelve flat tabs, no grouping.** Owners see Calls, Business, Services,
   Dentists, Calendar, Team, Billing, Settings, Voice Test, Customize in one wrapping row;
   on a phone it wraps into four rows of grey text. The operator sees twelve.
2. **Overlapping tabs.** Business details, *Customize* (store name, greeting, agent name),
   and *Settings* (voice, privacy, locale) all edit the same business. The business name
   is in two places; country/currency is in Business *and* Settings → Business locale.
3. **Jargon.** "Sector", "vertical", "Store Settings", "Max Recommendations", "STT/TTS",
   "provider", "Cartesia voice id", "Locale (BCP 47)", "Currency (ISO 4217)", "X-Admin-Key".
4. **Wrong audience.** Customize shows e-commerce fields (support email, max
   recommendations, primary colour) to clinics. Owner Settings shows a *Business* picker
   with a single option on every card. The operator Overview is hard-coded stats and Twilio
   webhook notes.
5. **Operator tools mixed into business tabs.** Phone-line default, number routing,
   WhatsApp routing and number requests are cards under the same *Settings* tab as a
   business's privacy notice, each with its own business dropdown.
6. **No "what do I do next".** After sign-up the owner lands on Voice Test with no sign of
   whether the business is ready (hours, services, team, phone number, privacy, billing).
   There is no summary of today's calls, bookings or messages.
7. **Look and feel.** Dark theme with low-contrast grey (#666–#888) text on near-black,
   no visible keyboard focus, disabled buttons that look like enabled ones, inline styles
   in every file so spacing and type sizes differ from card to card.
