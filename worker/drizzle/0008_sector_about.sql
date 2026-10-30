-- Free-text business facts (warranty, certifications, payment options…) that
-- the voice/WhatsApp agents quote from the business profile in their prompt.
ALTER TABLE sectors ADD COLUMN about TEXT;
