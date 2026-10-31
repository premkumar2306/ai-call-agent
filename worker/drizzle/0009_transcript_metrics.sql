-- Per-turn latency checkpoints for voice calls (JSON array), written with the
-- transcript at hang-up. Durable Object console output from async turn work
-- doesn't reliably reach tail/Workers Logs, so this is the record we chart.
ALTER TABLE transcripts ADD COLUMN metrics TEXT;
