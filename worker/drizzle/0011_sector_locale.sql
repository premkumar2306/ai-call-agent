-- Per-business locale (India launch, workstream A). `currency` already exists
-- (ISO 4217; prices are stored in its minor unit: cents, paise). The defaults
-- keep every existing business on US formatting.
ALTER TABLE sectors ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-US';
ALTER TABLE sectors ADD COLUMN country_code TEXT NOT NULL DEFAULT 'US';
