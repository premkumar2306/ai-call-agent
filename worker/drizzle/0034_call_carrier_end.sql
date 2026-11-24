-- Carrier-reported end of the call (Twilio/Plivo callbacks or a status read), stored next to
-- our own ended_at / duration_seconds so the two can be compared. Log-only: billing is unchanged.
ALTER TABLE call_outcomes ADD COLUMN carrier_ended_at INTEGER;
ALTER TABLE call_outcomes ADD COLUMN carrier_duration_seconds INTEGER;
-- How the line was ended: ws_close (carrier followed the stream close) | callback | status_poll | rest | unconfirmed.
ALTER TABLE call_outcomes ADD COLUMN hangup_method TEXT;
ALTER TABLE call_outcomes ADD COLUMN hangup_confirm_ms INTEGER;
