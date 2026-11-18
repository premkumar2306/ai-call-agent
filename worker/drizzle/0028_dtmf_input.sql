-- Keypad digits as an answer (phone number, date) while the assistant asks for
-- one. OFF by default: nothing changes for an existing business. Pressing 0
-- to reach staff needs no setting (it works whenever the business has a staff
-- phone).
ALTER TABLE sectors ADD COLUMN dtmf_input INTEGER NOT NULL DEFAULT 0;
