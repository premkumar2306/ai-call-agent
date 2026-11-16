-- Launch 2: overflow-only pilots on the clinic's existing number.
-- The clinic keeps its number; staff answer first; the carrier forwards
-- busy / no-answer / unreachable calls to the Avery number. Off by default:
-- nothing changes for a business without a pilot_configs row, and nothing is
-- written for its calls unless the carrier says the call was forwarded.

CREATE TABLE IF NOT EXISTS pilot_configs (
  business_type              TEXT PRIMARY KEY,     -- sectors.key
  enabled                    INTEGER NOT NULL DEFAULT 0,
  mode                       TEXT NOT NULL DEFAULT 'overflow',
  starts_on                  TEXT,                 -- YYYY-MM-DD, business time zone
  ends_on                    TEXT,                 -- YYYY-MM-DD inclusive
  clinic_number              TEXT,                 -- the clinic's own number (E.164) that forwards to Avery
  clinic_line                TEXT,                 -- jio | airtel | vi | bsnl | landline | ivr | other
  forwarding_test_started_at INTEGER,              -- unix seconds; "test your forwarding" window
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

-- How each call reached Avery. One row per carrier call.
CREATE TABLE IF NOT EXISTS call_routing (
  carrier        TEXT NOT NULL,                    -- twilio | exotel | plivo
  call_sid       TEXT NOT NULL,                    -- the carrier's call id (transcripts.call_sid)
  business_type  TEXT NOT NULL,
  called_number  TEXT,                             -- the Avery number dialled
  caller_hash    TEXT,                             -- same hash as transcripts.customer_id_hashed
  forwarded_from TEXT,                             -- the forwarding number, when the carrier sends it
  is_overflow    INTEGER NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,                    -- carrier_forwarded | pilot_overflow | direct
  pilot_active   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (carrier, call_sid)
);
CREATE INDEX IF NOT EXISTS idx_call_routing_business ON call_routing (business_type, created_at);
