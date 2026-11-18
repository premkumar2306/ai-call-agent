-- Launch 3: pilot metrics from real call and booking data.
-- call_outcomes: one row per call that reached the assistant (written by
-- CallRelay when the call ends; telemetry only, nothing user-visible).
-- metrics_settings: per business, the weekly summary and the shareable
-- read-only report link. Both are OFF by default.

CREATE TABLE IF NOT EXISTS call_outcomes (
  carrier          TEXT NOT NULL,
  call_sid         TEXT NOT NULL,
  business_type    TEXT NOT NULL,
  caller_hash      TEXT,
  started_at       INTEGER NOT NULL,     -- unix seconds, stream start
  ended_at         INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  user_turns       INTEGER NOT NULL DEFAULT 0,
  transferred      INTEGER NOT NULL DEFAULT 0,
  message_taken    INTEGER NOT NULL DEFAULT 0,
  is_test          INTEGER NOT NULL DEFAULT 0,  -- synthetic / dashboard test calls
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (carrier, call_sid)
);
CREATE INDEX IF NOT EXISTS idx_call_outcomes_business ON call_outcomes (business_type, started_at);

CREATE TABLE IF NOT EXISTS metrics_settings (
  business_type        TEXT PRIMARY KEY,
  weekly_summary       INTEGER NOT NULL DEFAULT 0,
  weekly_last_sent     TEXT,                 -- 'YYYY-MM-DD' (Monday) of the last week sent
  share_enabled        INTEGER NOT NULL DEFAULT 0,
  share_token          TEXT,                 -- random; changes when sharing is turned off and on
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_share_token ON metrics_settings (share_token);
