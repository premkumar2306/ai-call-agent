# Competition analysis: Avery (DeskZen) for Indian dental clinics

Seen on 2026-11-14. The full dataset, with one row per competitor and a source URL for each, is in [`competitors.csv`](competitors.csv).

> **Method and caveats.** This is desk research only. No vendor was contacted and no trial was started. Vendor pages could not be loaded directly from the research sandbox, so every figure comes from search-indexed pages: the vendor's own page where it was indexed, otherwise a third-party pricing guide. Each figure cites its source. Where sources conflict, the table gives the range or the most-cited figure. Anything that could not be verified is marked **unknown**. USD figures are converted at an **assumed ₹88/$**, which is a conversion and not a quoted price. Re-check the vendors' live pages before quoting any number to a customer.

## 1. Top 5 findings

1. **No funded player sells a turnkey Hindi or Hinglish AI receptionist with WhatsApp to single Indian clinics at SMB prices.**
   - Indian voice companies sell infrastructure by the minute: Ringg at ₹6/min and Bolna at ₹5.52/min.
   - Global AI receptionists cost 2.2–8.6× Avery for the same volume. None of them offers Hindi, WhatsApp, Indian numbers or billing in ₹.
2. **Practo is the incumbent, and it already uses AI voice.** Ringg runs booking calls on Practo's own lines (1,200+ clinics; 30k+ AI-handled appointments claimed). That work answers *Practo's* numbers, not the clinic's own phone. Avery should sit beside Practo or Clinicia, not replace it.
3. **Avery's real rival for the clinic's budget is "a receptionist plus a WhatsApp tool".**
   - AiSensy, WATI and Interakt cost ₹1,500–₹3,800/mo plus message fees. None of them answers the phone.
   - So Avery's pitch has to be *"never miss a call"*. WhatsApp is the follow-up, not the headline.
4. **Agencies can undercut Avery on raw cost.** An agency reselling Retell, Vapi or Bolna pays roughly ₹3–8k/mo for 600 minutes. Avery's moat is everything an agency has to build: the clinic workflow, DPDP consent, GST invoices in ₹, WhatsApp templates and fast setup.
5. **Avery's current plan already undercuts every other turnkey product.** The plan is ₹2,999/mo for 300 min, then ₹7/min. A typical clinic (600 min) pays **₹5,099/mo**. The per-minute overage makes the bill hard to predict, and Indian clinic owners push back on that. Move to a flat clinic bundle (§5).

## 2. Comparison matrix (features × competitors)

✅ = yes (sourced) · ➖ = partial or through an add-on or a build · ❌ = no or not found · ? = unknown

| Competitor | Type | Answers clinic calls | Hindi / Hinglish | WhatsApp | Booking into a calendar | Built for clinics | ₹ billing + GST | India numbers | Self-serve setup |
|---|---|---|---|---|---|---|---|---|---|
| **Avery (DeskZen)** | Turnkey AI receptionist | ✅ | ✅ / ✅ | ✅ templates, reminders, missed-call follow-up | ✅ Google Calendar | ✅ dental, medical | ✅ Razorpay | ✅ Exotel, Plivo | ➖ |
| Ringg AI | Indian voice platform | ➖ build | ✅ / ? | ❌ | ➖ custom | ➖ (Practo) | ✅ | ✅ | ❌ |
| Bolna | Indian voice platform | ➖ build | ✅ code-mixed | ❌ | ➖ API | ❌ | ✅ | ✅ | ❌ dev |
| Gnani (Inya) | Indian enterprise voice | ➖ build | ✅ / ? | ➖ | ➖ | ❌ | ? | ✅ | ❌ |
| Exotel | Indian carrier (CPaaS) | ➖ via partners | ➖ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Pluxo | Indian clinic AI front desk | ✅ | ? | ✅ | ✅ Google Calendar | ✅ | ? | ? | ? (48 h claim) |
| Awaaz Desk | Indian clinic AI receptionist | ✅ | ✅ / ✅ | ? | ✅ | ✅ | ? | ? | ? |
| Practo Ray | Clinic software | ❌ (calls: Ray Connect) | ❌ | ? | ✅ own | ✅ | ✅ | ✅ | ✅ |
| Clinicia | Clinic and dental software | ❌ | ❌ | ? | ✅ own | ✅ | ✅ | n/a | ✅ |
| Eka Care | Clinic software | ❌ | ➖ UI | ➖ add-on | ✅ own + Google Reserve | ✅ | ✅ | n/a | ✅ |
| AiSensy | WhatsApp bot builder | ❌ | ➖ text | ✅ | ➖ | ❌ | ✅ | n/a | ✅ |
| Interakt | WhatsApp bot builder | ❌ | ➖ text | ✅ | ➖ | ❌ | ✅ | n/a | ✅ |
| WATI | WhatsApp bot builder | ❌ | ➖ text | ✅ | ➖ | ❌ | ✅ | n/a | ✅ |
| Smith.ai | Global AI + human | ✅ | ❌ | ❌ | ✅ US tools | ➖ | ❌ | ❌ | ✅ |
| Rosie | Global AI | ✅ | ? | ❌ (SMS) | ✅ | ❌ | ❌ | ❌ | ✅ |
| Goodcall | Global AI | ✅ | ? | ❌ (SMS) | ✅ | ❌ | ❌ | ❌ | ✅ |
| My AI Front Desk | Global AI, white-label | ✅ | ? | ❌ (SMS) | ✅ | ❌ | ❌ | ❌ | ✅ |
| Arini | US dental AI | ✅ | ❌ | ❌ | ✅ dental practice software | ✅ dental | ❌ | ❌ | ❌ |
| Sully.ai | US medical AI suite | ✅ | ? | ❌ | ✅ health-record systems | ✅ | ❌ | ❌ | ❌ |
| Retell | Voice platform | ➖ build | ✅ same price | ❌ | ➖ | ❌ | ❌ | ❌ | ❌ |
| Vapi | Voice platform | ➖ build | ➖ by provider | ❌ | ➖ | ❌ | ❌ | ❌ | ❌ |
| Bland | Voice platform | ➖ build | ? | ❌ | ➖ | ❌ | ❌ | ❌ | ❌ |
| Synthflow | No-code voice (now enterprise) | ➖ build | ? | ❌ | ➖ | ❌ | ❌ | ❌ | ➖ |

## 3. Monthly cost for a typical clinic (300 calls × 2 min = 600 min)

| Option | ₹ / month (excl. GST) | How it's computed | Turnkey? |
|---|---|---|---|
| WATI (WhatsApp only) | ~2,500–3,000 | Growth plan + Meta message fees | No voice |
| Interakt (WhatsApp only) | ~2,800 | Growth plan + message fees | No voice |
| Bolna | ~3,300 | 600 × ₹5.52 pilot rate | Build required |
| AiSensy (WhatsApp only) | ~4,000 | Basic ₹1,500 + chatbot ₹2,500 + messages | No voice |
| Ringg | ~4,100 | 600 × ₹6 + ₹499 number | Build required |
| **Avery, recommended "Clinic" plan** | **4,999** | flat, 800 min included | ✅ |
| **Avery, current plan** | **5,099** | ₹2,999 + 300 × ₹7 | ✅ |
| Retell | ~3,700–11,600 | 600 × $0.07–0.22 | Build required |
| Bland | ~7,400+ | 600 × $0.14 + telephony | Build required |
| Vapi | ~7,900–19,000 | 600 × $0.15–0.36 all-in | Build required |
| Goodcall | ~11,400 | Growth $129 (≤250 unique callers) | ✅ (US) |
| Rosie | ~13,100 | Scale $149 (1,000 min) | ✅ (US) |
| My AI Front Desk | ~17,500 | $99 + 400 × $0.25 | ✅ (US) |
| Smith.ai AI | ~44,000 | Pro $500 for 300 calls | ✅ (US) |
| Synthflow | ~2,20,000 floor | reported $30k/yr minimum | Enterprise |
| Arini, Sully, Gnani, Exotel | unknown | quote only | — |
| Practo Ray / Clinicia / Eka | ~580–4,500 | software only, no AI answering | Complement, not substitute |

## 4. Positioning

**Avery's real differentiators**
- It is the only *turnkey* product found that combines all of these:
  - it answers the clinic's own number;
  - it speaks Hindi and Hinglish;
  - it books into a calendar;
  - it follows up on WhatsApp, including missed calls;
  - it records DPDP consent;
  - it bills in ₹ through Razorpay with GST invoices.
- Indian carriers (Exotel, Plivo) give local numbers and low per-minute cost.
- Running it costs a typical clinic less than any other turnkey product.

**Avery's real gaps** (ranked in §6)
- No sync with the dental software clinics already use (Practo, Clinicia, Eka).
- No Tamil, Telugu or Kannada, although current outreach targets Chennai, Hyderabad and Bengaluru.
- No Indian dental case studies yet.
- No recall or outbound campaigns.

**Who not to compete with head-on**
- **Practo.** Integrate, and position Avery as "the phone for your Practo diary". Practo already uses Ringg for its own lines.
- **Ringg and Bolna on enterprise or hospital deals.** They are funded and sell on per-minute price. Stay with single clinics and small chains.
- **WhatsApp tools on price.** Don't sell Avery as "a cheaper AiSensy". Sell the calls.

**Recommended price for Indian dental clinics**
- **Clinic plan: ₹4,999/mo + GST**, with 800 min, one Indian number, WhatsApp reminders and missed-call follow-up included. Overage ₹6/min. Keep **Starter at ₹2,999** (300 min) for single-chair clinics.
- **Founding offer:** setup is free and the first month is free for the first 25 clinics. The price is locked for 12 months.
- **Why this price:**
  - A flat price takes away the fear of a surprise bill. That fear is the top objection to per-minute pricing.
  - Typical usage (600 min) fits inside the plan with headroom.
  - ₹6/min overage matches Ringg's public rate, so Avery is never more expensive per minute than the infrastructure option.
  - ₹4,999 is close to a mid-tier WhatsApp tool (₹3–5k) while also answering calls.
  - It costs a fraction of a front-desk salary. *Salary benchmarks were not verified here; the owner should use local figures.*
  - It is 2–9× cheaper than every global turnkey alternative.
  - Before launch, check gross margin against the real cost per minute in the billing usage records (`costPerMinutePaise`).

**One-line pitches against the top 3 alternatives**
- **vs Practo or Clinicia:** "Keep Practo for your diary. Avery picks up the phone calls Practo can't, in Hindi, at 11 pm, and puts the booking straight into your calendar."
- **vs a WhatsApp bot (AiSensy, WATI, Interakt):** "A WhatsApp bot only helps patients who message you. Most patients still call, and Avery answers every call, then follows up on WhatsApp for you."
- **vs an agency on Retell, Vapi or Bolna:** "Agencies sell you a voice bot and an hourly invoice. Avery is live this week, already built for dental clinics, DPDP-compliant and billed in ₹ with GST, at one fixed monthly price."

**Objection handling**
- **"We already use Practo."**
  - Good. Avery doesn't replace Practo.
  - Practo brings patients through its marketplace, but the calls to *your* number still go unanswered when the front desk is busy or the clinic is closed.
  - Avery answers those calls and books them in. Show the missed-call count from their own call log.
- **"Our receptionist does this."**
  - Avery takes overflow, lunch hours, after-hours calls and Sundays. It doesn't replace your receptionist.
  - Your receptionist can't take two calls at once. Avery can.
  - Offer a two-week trial on call forwarding (busy or no answer) and count the calls it saves.
- **"Too costly."**
  - ₹4,999 a month is roughly what one recovered root-canal or implant patient is worth. *The owner should insert the clinic's own treatment fees.*
  - It costs less than a WhatsApp tool plus a part-time caller.
  - It's a flat fee with no per-call surprises, and the first month is free.

## 5. Pricing recommendation at a glance

| Plan | Price (excl. GST) | Included | Overage |
|---|---|---|---|
| Starter (single chair) | ₹2,999/mo | 300 min, 1 number, WhatsApp follow-up | ₹7/min |
| **Clinic (recommended default)** | **₹4,999/mo** | 800 min, 1 number, reminders, missed-call follow-up | ₹6/min |
| Multi-chair or small chain | ₹9,999/mo | 2,000 min, up to 3 numbers | ₹5/min |

## 6. Product gaps ranked by how often they would lose a deal

| # | Gap | Why it loses deals | One-line fix |
|---|---|---|---|
| 1 | No sync with dental software (Practo Ray, Clinicia, Eka, Dentee) | Clinics keep their diary there and fear double bookings in Google Calendar. | Ship read-only availability import first, plus a "WhatsApp the front desk to confirm" mode. Build a two-way Practo or Clinicia sync next. |
| 2 | No Tamil, Telugu or Kannada | The Chennai, Hyderabad and Bengaluru lead lists hold callers who don't speak Hindi. | Turn on Sarvam STT and TTS for ta, te and kn per business. Start with a Tamil pilot in Chennai. |
| 3 | No local proof (case studies, sample calls) | Dentists buy on what peers say. Global competitors show reviews. | Run 5 paid pilots in Bengaluru. Publish their recordings and missed-call-recovered metrics. |
| 4 | Setup friction or keeping the existing number | Clinics won't change their published number. | One-page conditional call-forwarding guide per Indian carrier (Jio, Airtel, Vi, BSNL), plus a 15-minute setup wizard. |
| 5 | No recall or outbound campaigns (6-month cleaning, no-shows) | Competitors (Pluxo) pitch revenue recovery, not only answering. | Add WhatsApp recall templates, then outbound recall calls. |
| 6 | Unreliable or unclear human handoff | Dentists worry about emergency or pain calls. | Live transfer to the doctor's mobile, plus urgent-keyword escalation on WhatsApp. |
| 7 | No booking deposit | Reduces no-shows for high-value treatments. | Send a Razorpay payment link when a booking is made (Razorpay is already integrated). |

## Sources

All seen on 2026-11-14 through search results. URLs for each competitor are also in `competitors.csv`.

**Indian voice platforms**
- Ringg: https://ringg.ai/pricing · https://www.ringg.ai/ai-voice-agent-pricing · https://www.ringg.ai/case-studies/practo · https://yourstory.com/2026/01/voice-ai-startup-ringgai-seriesa-arkam-ventures · https://india.entrepreneur.com/business-news/ringg-ai-extends-series-a-to-usd-15-mn-to-build-ai-agents · https://mezha.net/eng/bukvy/d588171e_indian_startup_ringg/
- Bolna: https://www.bolna.ai/pricing · https://docs.bolna.ai/pricing · https://inc42.com/features/the-unit-economics-of-indias-voice-ai-boom/ · https://yourstory.com/2025/11/bengaluru-startup-bolna-ai-voice-infrastructure-enterprises-indian-languages
- Gnani (Inya): https://apphub.webex.com/applications/inya-gnani
- Exotel: https://edesy.in/blog/exotel-ai-voice-agent-setup-guide-2026 · https://www.cloudtalk.io/blog/exotel-pricing/

**Indian clinic AI start-ups**
- Pluxo: https://peerlist.io/prabeshgoyal/project/pluxo--ai-front-desk-for-clinics-in-india
- Awaaz Desk: https://in.linkedin.com/in/hrushik

**Indian clinic software**
- Practo Ray: https://us.fitgap.com/products/ray-by-practo · https://codingclave.com/guides/best-physiotherapy-clinic-software-india-2026
- Clinicia: https://clinicia.com/app/pricing.php
- Eka Care: https://eka.care/practice-management/plan-pricing · https://www.eka.care/eka-for-doctors/emr-ehr-medical-software/cardiologists

**WhatsApp bot builders**
- AiSensy: https://aisensy.com/pricing · https://www.zoko.io/post/aisensy-pricing-plans
- Interakt: https://wanotifier.com/compare/wati-vs-interakt/ · https://www.getmonetizely.com/articles/how-does-haptiks-interakt-ai-agents-price-its-whatsapp-first-agentic-crm-for-indias-smb-market
- WATI: https://codingclave.com/blog/wati-pricing-india-2026 · https://blog.campaignhq.co/?p=4057 · https://www.capterra.com/p/204314/WATI/pricing/

**Global AI receptionists**
- Smith.ai: https://www.beside.com/blog/beside-vs-smith-ai · https://www.getnextphone.com/blog/smith-ai-pricing
- Rosie: https://www.cloudtalk.io/blog/rosie-ai-answering-service-pricing/ · https://heyrosie.com/blog/rosie-ai-vs-goodcall · https://heyrosie.com/pricing
- Goodcall: https://www.cloudtalk.io/blog/goodcall-pricing/ · https://dailyaifixs.com/blog/goodcall-pricing-2026-the-unique-customer-catch
- My AI Front Desk: https://schedulingkit.com/pricing-guides/my-ai-front-desk-pricing · https://dailyaifixs.com/blog/my-ai-front-desk-pricing-2026-the-200-minute-wall
- Arini: https://seedtable.com/companies/arini/funding-rounds/seed-2024-02 · https://www.rapidevelopers.com/md/ai-agents/ai-receptionist-for-dental-office
- Sully.ai: https://www.sully.ai/help-center/articles/what-is-the-cost-pricing-model-for-the-agents · https://www.cbinsights.com/company/odiggo/financials

**Voice-agent platforms**
- Retell: https://www.11x.ai/guides/retell-ai-pricing · https://community.retellai.com/t/differential-pricing-for-non-english-languages/1112 · https://caller.digital/voice-ai-pricing-comparison
- Vapi: https://www.zeeg.me/en/blog/post/vapi-ai-pricing · https://cloudtalk.io/blog/vapi-ai-pricing
- Bland: https://www.happyrobot.ai/hub/bland-ai-reviews-and-pricing · https://www.costbench.com/software/voice-ai-agents/bland-ai/hidden-costs/
- Synthflow: https://www.layer3labs.io/guides/synthflow-pricing · https://www.activepieces.com/blog/synthflow-pricing-2026-for-1k-10k-100k-minutes

**Avery's current plan:** `docs/razorpay-setup.md` (₹2,999/mo, 300 min, ₹7/min).
