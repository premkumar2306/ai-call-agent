-- Prod 3: WhatsApp production. Message templates managed from the operator
-- UI, 24-hour appointment reminders, missed-call follow-ups, number health
-- and a durable opt-out / consent record. Additive only; every new behaviour
-- is off until an operator or owner turns it on.

-- Meta message templates as last synced from the Graph API (or the
-- message_template_status_update webhook). One row per name + language.
CREATE TABLE IF NOT EXISTS wa_templates (
  name            TEXT NOT NULL,
  language        TEXT NOT NULL,              -- Meta code: en | hi (Hinglish = <name>_hinglish in en)
  purpose         TEXT,                       -- confirmation | reminder | cancellation | missed_call | NULL (not ours)
  variant         TEXT,                       -- en | hi | hi-en
  category        TEXT,                       -- UTILITY | MARKETING | AUTHENTICATION
  status          TEXT NOT NULL,              -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED | ...
  meta_id         TEXT,
  body            TEXT,
  param_count     INTEGER NOT NULL DEFAULT 0,
  rejected_reason TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (name, language)
);

-- Which template family each event uses (operator's choice). A family is a
-- base name: <name> in en and hi, <name>_hinglish in en for Hinglish.
CREATE TABLE IF NOT EXISTS wa_event_templates (
  event       TEXT PRIMARY KEY,               -- confirmation | reminder | cancellation | missed_call
  family      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Per-business switches (owner Settings → WhatsApp). Absent row = both off.
CREATE TABLE IF NOT EXISTS wa_business_settings (
  business_type        TEXT PRIMARY KEY,
  reminders            INTEGER NOT NULL DEFAULT 0,
  missed_call_followup INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

-- Reminder bookkeeping: sent once per booking.
ALTER TABLE orders ADD COLUMN reminder_sent_at INTEGER;
ALTER TABLE orders ADD COLUMN reminder_channel TEXT;      -- whatsapp | sms | skipped:<reason>

-- Opt-in / opt-out history per customer and business (latest row wins).
-- Kept on erasure: a suppression record is what honours "STOP" later.
CREATE TABLE IF NOT EXISTS messaging_consent (
  id                 TEXT PRIMARY KEY,
  business_type      TEXT NOT NULL,
  customer_id_hashed TEXT NOT NULL,
  action             TEXT NOT NULL,          -- opt_in | opt_out
  source             TEXT NOT NULL,          -- keyword:<word> | whatsapp_inbound | booking | operator
  channel            TEXT NOT NULL DEFAULT 'whatsapp',
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messaging_consent_customer ON messaging_consent (customer_id_hashed, business_type, created_at);

-- Number health as last read from Graph (quality, tier, display name).
CREATE TABLE IF NOT EXISTS wa_number_health (
  phone_number_id      TEXT PRIMARY KEY,
  display_phone_number TEXT,
  verified_name        TEXT,
  name_status          TEXT,
  quality_rating       TEXT,                 -- GREEN | YELLOW | RED | UNKNOWN
  messaging_limit_tier TEXT,                 -- TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED
  status               TEXT,
  error                TEXT,
  checked_at           INTEGER NOT NULL,
  alerted_rating       TEXT                  -- last rating the operator was emailed about
);
