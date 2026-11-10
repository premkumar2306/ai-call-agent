-- Workstream F: billing (plans, per-business billing accounts, usage metering,
-- month-end overage invoices, Razorpay webhook idempotency).
--
-- Billing is OFF for a business until it has a billing_accounts row with a
-- plan_id. Usage is metered for every call (cost visibility for the operator)
-- but nothing is charged or emailed without a plan.
-- Money is stored in paise (INR) / the plan currency's minor unit, excluding
-- GST; provider cost estimates in micro-USD.

CREATE TABLE IF NOT EXISTS billing_plans (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'INR',
  monthly_fee_paise        INTEGER NOT NULL,          -- excl. GST
  included_minutes         INTEGER NOT NULL,
  overage_paise_per_minute INTEGER NOT NULL,          -- excl. GST
  trial_days               INTEGER NOT NULL DEFAULT 0,
  gst_rate_bps             INTEGER NOT NULL DEFAULT 1800, -- 18.00%
  razorpay_plan_id         TEXT,                       -- plan_... (amount = fee incl. GST)
  is_active                INTEGER NOT NULL DEFAULT 1,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

-- Starter plan as data: ₹2,999/month, 300 minutes, ₹7/minute after, 14-day trial.
INSERT OR IGNORE INTO billing_plans
  (id, name, currency, monthly_fee_paise, included_minutes, overage_paise_per_minute, trial_days, gst_rate_bps, is_active, created_at, updated_at)
VALUES
  ('in_starter', 'Starter', 'INR', 299900, 300, 700, 14, 1800, 1, unixepoch(), unixepoch());

-- One row per business (sectors.key) that is billed.
CREATE TABLE IF NOT EXISTS billing_accounts (
  business_type            TEXT PRIMARY KEY,           -- sectors.key
  plan_id                  TEXT,                       -- NULL = billing off
  trial_ends_at            INTEGER,                    -- unix seconds
  razorpay_customer_id     TEXT,
  razorpay_subscription_id TEXT,
  subscription_status      TEXT,                       -- Razorpay status: created|authenticated|active|pending|halted|cancelled|completed|expired|paused
  current_period_end       INTEGER,                    -- unix seconds, from Razorpay
  legal_name               TEXT,
  gstin                    TEXT,
  billing_email            TEXT,                       -- falls back to sectors.notify_email
  address_line1            TEXT,
  address_line2            TEXT,
  city                     TEXT,
  state                    TEXT,
  postal_code              TEXT,
  country                  TEXT NOT NULL DEFAULT 'IN',
  alert_80_period          TEXT,                       -- 'YYYY-MM' the 80% email was sent for
  alert_100_period         TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_subscription ON billing_accounts (razorpay_subscription_id);

-- One row per call (or WhatsApp conversation). Written after the call ends.
CREATE TABLE IF NOT EXISTS usage_records (
  id                     TEXT PRIMARY KEY,
  business_type          TEXT NOT NULL,
  channel                TEXT NOT NULL,                -- voice | whatsapp
  provider               TEXT,                         -- twilio | exotel | meta
  source_id              TEXT NOT NULL,                -- callSid, or a WhatsApp conversation id
  period                 TEXT NOT NULL,                -- 'YYYY-MM' in Asia/Kolkata
  started_at             INTEGER NOT NULL,             -- unix seconds
  ended_at               INTEGER,
  duration_seconds       INTEGER NOT NULL DEFAULT 0,
  billable_minutes       INTEGER NOT NULL DEFAULT 0,   -- ceil(duration/60); 0 for test calls
  billable               INTEGER NOT NULL DEFAULT 1,
  stt_seconds            INTEGER NOT NULL DEFAULT 0,
  tts_chars              INTEGER NOT NULL DEFAULT 0,
  llm_model              TEXT,
  llm_input_tokens       INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens      INTEGER NOT NULL DEFAULT 0,
  llm_cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  llm_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros        INTEGER NOT NULL DEFAULT 0,   -- estimated provider cost
  created_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_source ON usage_records (channel, source_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_period ON usage_records (business_type, period);

-- Month-end close: one row per business per period.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id                 TEXT PRIMARY KEY,
  business_type      TEXT NOT NULL,
  period             TEXT NOT NULL,                    -- 'YYYY-MM'
  plan_id            TEXT,
  minutes_used       INTEGER NOT NULL,
  included_minutes   INTEGER NOT NULL,
  overage_minutes    INTEGER NOT NULL,
  overage_paise      INTEGER NOT NULL,                 -- excl. GST
  gst_paise          INTEGER NOT NULL,
  total_paise        INTEGER NOT NULL,                 -- overage incl. GST
  status             TEXT NOT NULL,                    -- no_overage | trial | billed | unbilled | failed
  razorpay_addon_id  TEXT,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_business_period ON billing_invoices (business_type, period);

-- Razorpay retries webhooks; each X-Razorpay-Event-Id is processed once.
CREATE TABLE IF NOT EXISTS razorpay_events (
  id          TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
