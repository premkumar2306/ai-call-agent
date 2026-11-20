-- Cost per call: which speech providers and exact models a call used, so the
-- operator cost page can show "Deepgram nova-3" / "Cartesia sonic-3.5" per
-- call and total usage by model. Old rows stay NULL (shown as unknown).
ALTER TABLE usage_records ADD COLUMN stt_provider TEXT;
ALTER TABLE usage_records ADD COLUMN stt_model TEXT;
ALTER TABLE usage_records ADD COLUMN tts_provider TEXT;
ALTER TABLE usage_records ADD COLUMN tts_model TEXT;
