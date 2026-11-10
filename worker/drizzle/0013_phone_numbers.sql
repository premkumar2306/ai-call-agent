-- Which business answers each phone number. Inbound calls on Twilio, Exotel
-- or Plivo look up the called number here (E.164, e.g. +918047123456);
-- numbers without a row keep the old behaviour (the admin "Phone line"
-- default, then TWILIO_DEFAULT_BUSINESS_TYPE / EXOTEL_DEFAULT_BUSINESS_TYPE).
CREATE TABLE IF NOT EXISTS phone_numbers (
  number         TEXT NOT NULL,
  provider       TEXT NOT NULL,   -- twilio | exotel | plivo
  business_type  TEXT NOT NULL,
  label          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (number, provider)
);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_business ON phone_numbers (business_type);
