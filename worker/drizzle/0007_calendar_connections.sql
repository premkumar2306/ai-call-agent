-- Per-business external calendar (Google today; provider adapters live in
-- src/services/calendar/). check_availability subtracts the calendar's busy
-- times; book_appointment / cancel_booking create and delete its events.
CREATE TABLE IF NOT EXISTS calendar_connections (
  business_type     TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  account_email     TEXT,
  calendar_id       TEXT NOT NULL DEFAULT 'primary',
  calendar_name     TEXT,
  refresh_token_enc TEXT NOT NULL,
  check_busy        INTEGER NOT NULL DEFAULT 1,
  write_events      INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active',
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

ALTER TABLE orders ADD COLUMN calendar_event_id TEXT;
ALTER TABLE orders ADD COLUMN calendar_sync TEXT;
