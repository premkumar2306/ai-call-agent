# Razorpay setup (billing)

This is for the owner of the Avery deployment. It covers getting from no Razorpay account to
live payments: KYC, keys, the webhook, GST, plans, a full test-mode run, and the switch to live.

Billing is **off** for every business until you give it a plan. A business without a plan (the
US business, for example) is never charged, emailed about billing or changed by any of this.

## 1. Account and KYC

1. Sign up at dashboard.razorpay.com with the business's PAN, bank account and GSTIN.
2. Complete **KYC** (Account & Settings → Business details). Until it is approved you can use
   **test mode** only; nothing below needs live mode until step 8.
3. Ask Razorpay support to enable **Subscriptions** on the account. They are usually on by default
   for registered businesses, and UPI AutoPay needs it.

## 2. Test keys vs live keys

Razorpay has two separate key pairs, and each has its own plans, subscriptions and webhooks:

| | Key id starts with | Charges real money |
|---|---|---|
| Test mode | `rzp_test_` | no |
| Live mode | `rzp_live_` | yes |

Plans created in test mode do **not** exist in live mode. After switching keys you sync the plans
again (step 8).

## 3. API keys

Dashboard → Account & Settings → **API keys** → Generate key. Then:

```sh
cd worker
wrangler secret put RAZORPAY_KEY_ID       # rzp_test_… (the key id is also sent to Checkout)
wrangler secret put RAZORPAY_KEY_SECRET   # signs API calls and verifies Checkout's payment signature
```

Never paste the secret anywhere else. It isn't logged, and it isn't shown in the admin UI.

## 4. Webhook

Dashboard → Account & Settings → **Webhooks** → Add new webhook:

- **URL:** `https://<your-worker-host>/razorpay/webhook`
- **Secret:** a long random string. Then run `wrangler secret put RAZORPAY_WEBHOOK_SECRET` with the same value.
- **Active events:**
  - `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
    `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
    `subscription.completed`, `subscription.paused`, `subscription.resumed`, `subscription.updated`
  - `payment.captured`, `payment.failed`
  - `invoice.paid`
  - `refund.processed` (refunds are shown on the invoice; issue refunds in the Dashboard)

Every webhook is checked against `X-Razorpay-Signature` (an HMAC of the raw body). Without the
secret, production rejects every webhook. Each event is applied once (by `X-Razorpay-Event-Id`),
so Razorpay's retries are safe.

## 5. GSTIN and invoice details

Set these as plain vars (wrangler.toml `[vars]` or Dashboard → Worker → Settings → Variables):

| Var | Example | Used for |
|---|---|---|
| `BILLING_SUPPLIER_GSTIN` | `27AAAAA0000A1Z5` | Printed on invoices. Same state as the customer's GSTIN → CGST + SGST, otherwise IGST |
| `BILLING_SUPPLIER_NAME` | `Avery Technologies Pvt Ltd` | Supplier name on invoices |
| `BILLING_SUPPLIER_ADDRESS` | `…, Mumbai 400001` | Supplier address on invoices |
| `BILLING_SAC_CODE` | (ask your CA) | Printed next to the description if set |
| `BILLING_GRACE_DAYS` | `7` (default) | Days after a failed payment before extra minutes pause |
| `APP_URL` | `https://app.example.com` | Link in billing emails |

Each payment Razorpay collects gets a GST tax invoice numbered `AVY/26-27/000001`, `…000002`, and
so on. The series restarts every financial year (April). The invoice is emailed to the business's
billing email (Resend) and can be downloaded from Settings → Billing. Owners add their own GSTIN
and address under **Billing details**.

## 6. Plans and offers

Plans live in the database: prices in paise, **excluding GST**. Two plans are seeded:

| Plan id | Name | Price (excl. GST) | Included | After that | Trial | Role |
|---|---|---|---|---|---|---|
| `in_clinic` | **Clinic** (headline, `isFeatured`) | ₹4,999/month (₹5,898.82 incl. 18% GST) | 800 minutes | ₹6/minute | 14 days | Most clinics (migration 0022) |
| `in_starter` | Starter | ₹2,999/month (₹3,538.82 incl. GST) | 300 minutes | ₹7/minute | 14 days | Single-chair clinics (migration 0016) |

Neither exists in Razorpay until you sync it. **Sync both** (once in test mode, again in live mode):

```sh
W=https://<worker-host>; H="X-Admin-Key: $ADMIN_SECRET"
curl -X POST $W/admin/billing/plans/in_clinic/razorpay  -H "$H"   # Razorpay plan: ₹5,898.82/month incl. GST
curl -X POST $W/admin/billing/plans/in_starter/razorpay -H "$H"   # Razorpay plan: ₹3,538.82/month incl. GST
curl $W/admin/billing/plans -H "$H"                                # each now has a razorpayPlanId
```

To add or change a plan (all fields; `setupFeePaise`, `isFeatured`, `audience` are optional):

```sh
curl -X PUT $W/admin/billing/plans/in_clinic -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Clinic","monthlyFeePaise":499900,"includedMinutes":800,"overagePaisePerMinute":600,"trialDays":14,"setupFeePaise":0,"isFeatured":true}'
```

`setupFeePaise` is a one-off fee charged with the first payment (sent to Razorpay as an upfront
add-on on the subscription). It is **0 on both seeded plans**: set it if you charge for setup.

You can also do this in the admin UI (Operator → **Plans & billing**): there you choose the plan new
businesses start on, give a business a plan, and create the plan in Razorpay. Owners also choose
Clinic or Starter on the last step of signup (Indian businesses only; nothing is charged then).

Razorpay plans can't be edited. After a price change, clear the stored id
(`"razorpayPlanId": null` in the PUT) and sync again: new subscriptions use the new plan and
existing ones keep the old price.

### Offers (the founding offer)

An offer is a code, not a price: it never changes the plan's monthly fee. It can give a longer
free period (`freeDays`, which replaces a shorter trial; Razorpay's first charge is moved to its
end with `start_at`) and waive the plan's setup fee (`waiveSetupFee`). Seats are capped
(`maxRedemptions`) and claimed atomically.

Seeded by migration 0022: **`FOUNDING25`**: first 25 clinics, Clinic plan only, free setup and the
first month free (30 days).

```sh
curl $W/admin/billing/offers -H "$H"                                   # every offer with seats used
curl -X POST $W/admin/billing/accounts/<business>/offer -H "$H" -H 'content-type: application/json' -d '{"code":"FOUNDING25"}'
curl -X PUT $W/admin/billing/offers/FOUNDING25 -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Founding clinic","freeDays":30,"waiveSetupFee":true,"planIds":"in_clinic","maxRedemptions":25,"isActive":false}'   # close it
```

Owners can enter a code on the signup plan step or under Settings → Billing until they subscribe.
One offer per business.

## 7. Test-mode run

With **test** keys:

1. Sync both plans (step 6). Create a test business as an owner and pick **Clinic** with the
   `FOUNDING25` code on the last signup step. Its Billing page shows **Free trial: 30 days left**,
   the founding offer, and **Included minutes used: 0 of 800**.
2. **Subscribe** opens Razorpay Checkout. Pay with:
   - **UPI:** `success@razorpay` succeeds and `failure@razorpay` fails.
   - **Card:** use a card from Razorpay's *Test card details* page that supports recurring
     payments (any future expiry, any CVV, OTP page: Success).
   Billing then shows **Subscribed**, with the next charge at the trial's end.
3. Close Checkout without paying. You see "Nothing was charged".
4. In the Dashboard, open the subscription. Test mode lets you trigger charges and failures:
   - A failed charge marks Billing **Payment failed**, the owner gets an email, and the next
     action becomes **Update payment**.
   - After `BILLING_GRACE_DAYS`, or at once if Razorpay halts the subscription, minutes beyond the
     plan pause. Calls are still answered.
5. A successful charge produces an invoice under Settings → Billing → **Invoices** and emails it.
6. Month end: the daily cron (02:17 India time) adds last month's extra minutes as an add-on on
   the next charge. To run it by hand:
   `curl -X POST $W/admin/billing/close-period -H "$H" -H 'content-type: application/json' -d '{"period":"2026-11"}'`
7. **Cancel subscription** keeps the subscription active until the paid period ends, then it
   shows **Cancelled**.

The same flow is automated, against a local Razorpay stand-in, in `cd worker && npm run e2e -- razorpay`.

## 8. Going live

Once KYC is approved:

1. Generate **live** API keys and replace both secrets (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
2. Add the webhook again **in live mode** (same URL and events, new secret) and replace
   `RAZORPAY_WEBHOOK_SECRET`.
3. Re-create each plan (`in_clinic` and `in_starter`) in Razorpay: clear the stored test plan id, then sync:
   `curl -X PUT $W/admin/billing/plans/in_starter -H "$H" -H 'content-type: application/json' -d '{…same fields…, "razorpayPlanId": null}'`
   then `curl -X POST $W/admin/billing/plans/in_starter/razorpay -H "$H"`.
4. Businesses that subscribed in test mode have test subscription ids. Turn their billing off and
   on again (Plans & billing → plan → Billing off → plan) so they subscribe again in live mode.
5. Run one real ₹ payment from a business you own. Check the invoice, then cancel it.
