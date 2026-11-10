-- India workstream B: per-business phone-line language and STT/TTS providers.
-- Defaults reproduce the existing pipeline (English, Deepgram, Cartesia), so
-- every existing business keeps behaving exactly as before.
ALTER TABLE sectors ADD COLUMN voice_language TEXT NOT NULL DEFAULT 'en';   -- en | hi | hi-en
ALTER TABLE sectors ADD COLUMN stt_provider TEXT NOT NULL DEFAULT 'deepgram'; -- deepgram | sarvam
ALTER TABLE sectors ADD COLUMN tts_provider TEXT NOT NULL DEFAULT 'cartesia'; -- cartesia | sarvam
-- Cartesia voice id or Sarvam Bulbul speaker. NULL = the provider default.
ALTER TABLE sectors ADD COLUMN voice_id TEXT;
