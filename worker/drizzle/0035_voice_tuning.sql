-- Call feel, per business. NULL = automatic: the calmer set for Indian businesses
-- (country IN), today's behaviour for everyone else. Nothing changes until a value is set
-- or the business is Indian.
ALTER TABLE sectors ADD COLUMN speaking_rate TEXT;             -- slow | normal | fast
ALTER TABLE sectors ADD COLUMN interruption_sensitivity TEXT;  -- low | normal | high
ALTER TABLE sectors ADD COLUMN endpointing TEXT;               -- patient | normal
ALTER TABLE sectors ADD COLUMN noise_cancellation INTEGER;     -- 1 on / 0 off; Plivo <Stream> only
