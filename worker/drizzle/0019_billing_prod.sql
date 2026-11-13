-- Prod 1: billing end to end. Dunning state, owner plan changes and
-- cancellation, GST tax invoices with a per-financial-year number series.
-- Additive only: no existing row changes meaning, and a business without a
-- plan (billing off, e.g. the US business) is untouched.

ALTER TABLE billing_accounts ADD COLUMN past_due_since INTEGER;            -- first failed charge of the current episode
ALTER TABLE billing_accounts ADD COLUMN last_payment_status TEXT;          -- captured | failed
ALTER TABLE billing_accounts ADD COLUMN last_payment_at INTEGER;           -- payment.created_at; older events are ignored
ALTER TABLE billing_accounts ADD COLUMN last_payment_error TEXT;
ALTER TABLE billing_accounts ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN pending_plan_id TEXT;              -- downgrade waiting for the cycle end
ALTER TABLE billing_accounts ADD COLUMN last_notice TEXT;                  -- last dunning/trial notice sent (dedupe key)

-- GST tax invoice, one per payment Razorpay collects (invoice.paid).
CREATE TABLE IF NOT EXISTS tax_invoices (
  id                  TEXT PRIMARY KEY,
  invoice_number      TEXT NOT NULL,                -- AVY/26-27/000001
  business_type       TEXT NOT NULL,
  razorpay_invoice_id TEXT,
  razorpay_payment_id TEXT,
  issued_at           INTEGER NOT NULL,
  period_start        INTEGER,
  period_end          INTEGER,
  lines_json          TEXT NOT NULL,                -- [{ description, amountPaise }] excl. GST
  taxable_paise       INTEGER NOT NULL,
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise         INTEGER NOT NULL,
  gst_rate_bps        INTEGER NOT NULL,
  supplier_gstin      TEXT,
  customer_gstin      TEXT,
  customer_json       TEXT,                         -- legal name and address at the time of issue
  place_of_supply     TEXT,                         -- 2-digit state code
  refunded_paise      INTEGER NOT NULL DEFAULT 0,
  emailed_at          INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_invoices_number ON tax_invoices (invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_invoices_rzp ON tax_invoices (razorpay_invoice_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_business ON tax_invoices (business_type, issued_at);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_payment ON tax_invoices (razorpay_payment_id);

-- Gapless invoice numbers per Indian financial year (April–March).
CREATE TABLE IF NOT EXISTS invoice_counters (
  fy   TEXT PRIMARY KEY,                            -- '26-27'
  last INTEGER NOT NULL
);
