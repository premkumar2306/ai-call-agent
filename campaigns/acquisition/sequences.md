# Outreach sequences (draft; owner approves and sends by hand)

Merge fields come from `leads.csv`: `{name}`, `{area}`, `{city}`, `{first_line}`, `{demo_url}`.
`{demo_url}` = `https://demo.deskzen.in/?demo={demo_slug}` (the personalized demo site, built by
the demo workstream). Before sending, open the demo link once to check it renders the clinic name.
Read `compliance-checklist.md` first. Sender: Prem, DeskZen, premkumar@deskzen.in.

**Don't double up with the running email campaign.** It mails `campaigns/india-dental-leads`
clinics with the subject prefix `[Avery dental pilot]`. These leads aren't on those lists. Use a
different subject so replies are easy to tell apart, and don't change the campaign script.

---

## 1. Email (3 touches)

### Touch 1 (day 0). Subject: `{name}: missed calls after 7 pm?`

> Hi {name} team,
>
> {first_line}
>
> We built Avery, an AI receptionist that picks up when your front desk can't (busy, lunch,
> after hours). It books the appointment and sends the patient a WhatsApp confirmation, in English or Hindi.
>
> I made a 1-minute demo set up for {name}: {demo_url}
>
> We're offering a free 14-day pilot. You keep your number; we only forward the calls you miss.
> If it doesn't catch 5 bookings you'd have lost, you pay nothing.
>
> Worth a 15-minute call this week?
>
> Prem, DeskZen · premkumar@deskzen.in
> Not relevant? Reply "stop" and I won't write again.

### Touch 2 (day 3). Same thread. Subject: `Re: {name}: missed calls after 7 pm?`

> Hi again. One number that may help: most dental clinics we spoke to miss 1 in 5 calls at peak
> hours. One recovered implant or aligner case pays for a year of Avery (₹2,999/month after the pilot).
>
> Try calling your demo receptionist yourself: {demo_url}
>
> Prem · Reply "stop" to opt out.

### Touch 3 (day 7). Breakup. Subject: `Re: {name}: missed calls after 7 pm?`

> Last note from me. If missed calls aren't a problem at {name}, that's great, and I'll close
> this out. If they are, reply "pilot" and I'll set it up in 20 minutes on a call. No card needed.
>
> Prem · DeskZen · Reply "stop" and I won't contact you again.

### Hinglish variant (Touch 1). Use for Hyderabad/North-Indian-run clinics when the site or listing is in Hindi.

> Namaste {name} team,
>
> {first_line}
>
> Jab aapka front desk busy ho ya clinic band ho, tab Avery, hamara AI receptionist, call
> uthata hai. Appointment book karta hai aur patient ko WhatsApp par confirmation bhejta hai, Hindi ya English mein.
>
> {name} ke liye 1 minute ka demo: {demo_url}
>
> 14 din ka free pilot hai. Number wahi rahega. Agar 5 missed bookings nahi pakdi, toh koi charge nahi.
> Is hafte 15 minute baat kar sakte hain?
>
> Prem, DeskZen · Interest nahi hai toh "stop" reply karein, dobara message nahi aayega.

---

## 2. WhatsApp (2 messages)

Only to a number the clinic publishes as WhatsApp (`whatsapp` column, from its own website),
sent manually and one to one from the DeskZen WhatsApp Business app. Never bulk.

**Message 1**

> Hi {name}, I'm Prem from DeskZen (Bengaluru). We make an AI receptionist for dental clinics
> that answers calls your team misses and books them on WhatsApp. Here's a 1-min demo made for
> your clinic: {demo_url}
> Free 14-day pilot, same number. Would you like it? Reply STOP and I won't message again.

**Message 2** (only if no reply, 4+ days later; then stop for good)

> Hi, just checking if you saw the demo for {name}: {demo_url}. Happy to set up the free pilot
> on a 15-min call. If not interested, no worries. Reply STOP and I won't message again.

**Hinglish**

> Namaste {name}, main Prem, DeskZen se. Hum dental clinics ke liye AI receptionist banate
> hain. Jo calls miss ho jaati hain, unhe uthakar appointment book karta hai. Aapke clinic ka demo:
> {demo_url}. 14 din free pilot, number same rahega. Interest ho toh reply karein.
> STOP likhein toh dobara message nahi aayega.

---

## 3. Cold-call script (manual, founder only; see TRAI notes in the checklist)

Best done **after** an email/WhatsApp, as a follow-up. If the receptionist picks up on the 1st ring,
the pitch changes: "you clearly answer fast, so this is about after-hours and lunch."

1. **Permission (10 s).** "Hi, this is Prem from DeskZen in Bengaluru. Is this a bad time? I have one
   quick question for Dr {doctor or 'the doctor'}." *If no, ask when, or end the call politely.*
2. **Question.** "When the front desk is with a patient, or after 8 pm, what happens to calls?"
   *(Listen. Typical: "goes unanswered", "doctor's mobile", "we call back".)*
3. **Pitch (20 s).** "We built an AI receptionist that answers only those missed calls, books the
   appointment and WhatsApps the patient. Your number doesn't change. I've made a demo for your clinic
   I can WhatsApp or email you."
4. **Ask.** "Can I set up a free 14-day pilot? If it doesn't catch 5 bookings, you pay nothing."
5. **Objections.**
   - *"We have a receptionist."* "Avery doesn't replace her. It covers lunch, busy times and after hours."
   - *"Patients won't talk to a robot."* "Listen to the demo. It speaks Hindi and English, says it's an
     assistant, and hands over to your team for anything clinical."
   - *"Price?"* "Free for 14 days, then ₹2,999 a month. That's less than one RCT."
   - *"Send details."* "Sure. Email or WhatsApp?" Send the demo link within 5 minutes.
6. **Close.** Book a 20-minute setup slot. Log the outcome in `pipeline.csv`.
   **If they say don't call, write `dnc` in `consent_status` and never call again.**

**Hindi/Hinglish opener:** "Namaste, main Prem bol raha hoon DeskZen se, Bengaluru. Ek minute
baat kar sakte hain? Doctor sahab ke liye ek chhota sa sawaal tha: jab reception busy hota hai ya
clinic band ho, tab patient ki call ka kya hota hai?"

---

## 4. LinkedIn note (to clinic owner/founder dentist, max 300 chars)

> Hi Dr {last_name}, I'm building DeskZen, an AI receptionist that answers the calls a dental clinic
> misses (busy, lunch, after hours) and books on WhatsApp. I made a 1-min demo for {name}: {demo_url}.
> Would value your view, even if it's "not for us".

Follow-up after accepting (one message only):

> Thanks for connecting, Dr {last_name}. We're giving 10 clinics in {city} a free 14-day pilot, and a
> locked founding price if they stay. Happy to set yours up, or just hear what you think of the demo.

LinkedIn is manual only, with no automation tools. Stop if there's no reply.
