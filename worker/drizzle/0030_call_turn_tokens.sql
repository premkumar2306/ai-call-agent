-- LLM tokens per turn, so a turn can be priced (services/turn-timeline.ts turnCost).
ALTER TABLE call_turn_metrics ADD COLUMN llm_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_turn_metrics ADD COLUMN llm_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_turn_metrics ADD COLUMN llm_cache_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_turn_metrics ADD COLUMN llm_cache_write INTEGER NOT NULL DEFAULT 0;
