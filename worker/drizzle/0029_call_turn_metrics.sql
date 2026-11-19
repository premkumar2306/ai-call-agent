-- Per-turn latency timeline and cost counters (services/turn-timeline.ts).
-- One row per caller turn; times are ms offsets from the STT end-of-speech signal.
CREATE TABLE IF NOT EXISTS call_turn_metrics (
  id TEXT PRIMARY KEY NOT NULL,
  call_sid TEXT NOT NULL,
  business_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  turn_n INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  end_signal TEXT NOT NULL,
  endpointing_ms INTEGER,
  t_speech_end INTEGER NOT NULL DEFAULT 0,
  t_final INTEGER,
  t_first_phrase INTEGER,
  t_first_tts INTEGER,
  t_first_sent INTEGER,
  t_first_filler_sent INTEGER,
  t_playback_done INTEGER,
  tools TEXT NOT NULL DEFAULT '[]',
  stt_audio_s REAL NOT NULL DEFAULT 0,
  tts_chars INTEGER NOT NULL DEFAULT 0,
  cached_audio INTEGER NOT NULL DEFAULT 0,
  audio_cache TEXT,
  barge_in INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'done',
  stt_provider TEXT NOT NULL,
  tts_provider TEXT NOT NULL,
  llm_model TEXT NOT NULL,
  sync_dtmf_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_turn_metrics_call ON call_turn_metrics (call_sid, turn_n);
CREATE INDEX IF NOT EXISTS idx_call_turn_metrics_biz_started ON call_turn_metrics (business_type, started_at);
