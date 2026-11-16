-- Launch 6: practice software (Practo, Clinicia, Eka, others).
-- Front-desk confirmation mode: Avery takes the request, the clinic's front
-- desk confirms it (or suggests another time) with one tap, and the patient
-- is told it is pending until then. Read-only availability import from an
-- iCalendar (ICS) feed. Both OFF by default; nothing changes without a row.

CREATE TABLE IF NOT EXISTS practice_settings (
  business_type      TEXT PRIMARY KEY,
  software           TEXT,                       -- practo | clinicia | eka | other | none (informational)
  confirmation_mode  INTEGER NOT NULL DEFAULT 0, -- front-desk confirmation for every booking
  front_desk_phone   TEXT,                       -- E.164; gets the confirm / suggest link (SMS, or WhatsApp inside 24 h)
  ics_import         INTEGER NOT NULL DEFAULT 0, -- read-only busy times from ics_url
  ics_url            TEXT,                       -- https:// iCalendar feed (secret-ish: stored, never shown back in full)
  ics_last_sync      INTEGER,
  ics_last_error     TEXT,
  ics_busy_count     INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

ALTER TABLE orders ADD COLUMN front_desk_status TEXT;   -- pending | confirmed | suggested
ALTER TABLE orders ADD COLUMN front_desk_token TEXT;    -- random, in the front desk's link
ALTER TABLE orders ADD COLUMN suggested_at TEXT;        -- business-local time the front desk suggested
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_front_desk_token ON orders (front_desk_token);
