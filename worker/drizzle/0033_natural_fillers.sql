-- "Natural fillers": cached short acknowledgements ("Let me check the slots…")
-- while a tool or the model is working, so the caller never hears dead air.
-- OFF by default: nothing changes for an existing business. New Indian
-- businesses get it on from the onboarding preset.
ALTER TABLE sectors ADD COLUMN natural_fillers INTEGER NOT NULL DEFAULT 0;
