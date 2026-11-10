-- Self-serve business-owner accounts (workstream E).
-- Owners sign in with a one-time code sent by email; each user can belong to
-- several businesses (sectors rows) as owner or staff. ADMIN_SECRET keeps
-- working as the operator's superuser key alongside these accounts.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,              -- lower-cased, trimmed
  name            TEXT,
  phone           TEXT,                       -- reserved for phone OTP later
  -- Bumped on "log out": every token carries the version it was issued
  -- under, so older tokens stop working on every device.
  session_version INTEGER NOT NULL DEFAULT 1,
  last_login_at   INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS business_members (
  business_key TEXT NOT NULL,                 -- sectors.key
  user_id      TEXT NOT NULL,                 -- users.id
  role         TEXT NOT NULL DEFAULT 'staff', -- owner | staff
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (business_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members (user_id);

-- One live code per address. Only an HMAC of the code is stored.
CREATE TABLE IF NOT EXISTS login_codes (
  identifier TEXT PRIMARY KEY,                -- 'email:<address>' (later 'phone:<e164>')
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- What kind of business this is (clinic, salon, auto_shop…), set by the
-- onboarding wizard. NULL for businesses created before self-serve signup.
ALTER TABLE sectors ADD COLUMN kind TEXT;
