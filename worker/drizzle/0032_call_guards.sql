-- Runaway-call guards and barge-in diagnostics.
-- Per-business overrides (NULL = the built-in default: 20 s / 10 s / 5 min).
ALTER TABLE sectors ADD COLUMN silence_prompt_sec INTEGER;
ALTER TABLE sectors ADD COLUMN silence_hangup_sec INTEGER;
ALTER TABLE sectors ADD COLUMN max_call_minutes INTEGER;
-- Why the call ended: silence | max_duration | dead_media | caller_hangup | agent_hangup | transfer | error.
ALTER TABLE call_outcomes ADD COLUMN end_reason TEXT;
-- Barge-in decisions and interruptions for the turn (JSON), shown on the operator timeline.
ALTER TABLE call_turn_metrics ADD COLUMN barge TEXT;
