-- Launch 1: Clinic plan as the headline, Starter kept for single-chair clinics,
-- and offers (coupons) such as the founding offer for the first 25 clinics.
-- Additive only. A business without a plan (billing off, e.g. the US business)
-- is untouched, and nobody gets an offer until a code is applied.

ALTER TABLE billing_plans ADD COLUMN setup_fee_paise INTEGER NOT NULL DEFAULT 0; -- one-off, excl. GST, charged with the first payment
ALTER TABLE billing_plans ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;     -- the headline plan on signup and pricing
ALTER TABLE billing_plans ADD COLUMN audience TEXT;                              -- one line: who the plan is for

-- Clinic: ₹4,999/month + GST, 800 minutes, ₹6/minute after, 14-day trial (like Starter).
INSERT OR IGNORE INTO billing_plans
  (id, name, currency, monthly_fee_paise, included_minutes, overage_paise_per_minute, trial_days, gst_rate_bps,
   is_active, is_featured, audience, created_at, updated_at)
VALUES
  ('in_clinic', 'Clinic', 'INR', 499900, 800, 600, 14, 1800, 1, 1,
   'Most clinics: up to about 400 calls a month', unixepoch(), unixepoch());

UPDATE billing_plans SET audience = 'Single-chair clinics with fewer calls'
  WHERE id = 'in_starter' AND audience IS NULL;

-- Offers: a code an owner enters (or the operator applies) before subscribing.
-- free_days replaces the plan's trial with a longer free period; waive_setup_fee
-- drops the plan's setup fee. max_redemptions caps how many businesses get it.
CREATE TABLE IF NOT EXISTS billing_offers (
  code              TEXT PRIMARY KEY,                 -- upper case, e.g. FOUNDING25
  name              TEXT NOT NULL,
  description       TEXT,
  free_days         INTEGER NOT NULL DEFAULT 0,
  waive_setup_fee   INTEGER NOT NULL DEFAULT 0,
  plan_ids          TEXT,                             -- comma-separated plan ids it applies to; NULL = any
  max_redemptions   INTEGER,                          -- NULL = unlimited
  redeemed          INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER,                          -- unix seconds; NULL = no end date
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Founding offer: first 25 clinics, free setup and a free first month (30 days).
INSERT OR IGNORE INTO billing_offers
  (code, name, description, free_days, waive_setup_fee, plan_ids, max_redemptions, redeemed, is_active, created_at, updated_at)
VALUES
  ('FOUNDING25', 'Founding clinic', 'First 25 clinics: free setup and the first month free', 30, 1, 'in_clinic', 25, 0, 1,
   unixepoch(), unixepoch());

ALTER TABLE billing_accounts ADD COLUMN offer_code TEXT;
ALTER TABLE billing_accounts ADD COLUMN offer_applied_at INTEGER;
