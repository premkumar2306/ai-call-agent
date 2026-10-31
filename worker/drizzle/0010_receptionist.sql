-- What a real front desk captures with a booking, who gets told about it,
-- how many visits may start at once, and messages for staff.
ALTER TABLE orders ADD COLUMN customer_name TEXT;
ALTER TABLE orders ADD COLUMN vehicle TEXT;
ALTER TABLE orders ADD COLUMN callback_phone TEXT;
ALTER TABLE orders ADD COLUMN notes TEXT;

-- Bookings/messages are emailed here (RESEND_API_KEY required). NULL = no email.
ALTER TABLE sectors ADD COLUMN notify_email TEXT;
-- Different customers' visits allowed to start at the same time (bays/lifts).
ALTER TABLE sectors ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS call_messages (
  id             TEXT PRIMARY KEY,
  business_type  TEXT NOT NULL,
  call_sid       TEXT,
  caller_name    TEXT,
  callback_phone TEXT,
  message        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'NEW',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_messages_business_created ON call_messages (business_type, created_at);
