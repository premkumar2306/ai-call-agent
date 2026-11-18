-- Conversation guardrails (docs/guardrails.md). Both parts are additive.
-- sectors.guardrails: NULL / 0 = off (the default; behaviour unchanged), 1 = on for this business.
ALTER TABLE sectors ADD COLUMN guardrails INTEGER;

-- One row per guardrail that fired on a call: emergency, self_harm, abuse,
-- injection, pii, advice, blocked_price, blocked_booking, blocked_promise.
-- `detail` is a short label, never the caller's words.
CREATE TABLE IF NOT EXISTS guardrail_events (
  id            TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,
  call_sid      TEXT,
  kind          TEXT NOT NULL,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_business ON guardrail_events (business_type, created_at);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_call ON guardrail_events (call_sid);
