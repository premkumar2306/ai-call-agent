-- General app: clinics, dental and law firms (self-serve). Additive; the US
-- business advanced_vtech keeps exactly what it says today.

-- The assistant's spoken name. NULL = "Avery". advanced_vtech's callers have
-- always heard "Mogi", so it keeps that name.
ALTER TABLE sectors ADD COLUMN assistant_name TEXT;
UPDATE sectors SET assistant_name = 'Mogi' WHERE key = 'advanced_vtech';

-- Signed-up businesses got a kind but no vertical, so they all used the auto
-- shop script. Give them the vertical their kind maps to (services/verticals.ts
-- verticalForKind). Businesses with a vertical, or no kind, are not touched.
UPDATE sectors SET vertical = CASE kind
    WHEN 'clinic' THEN 'clinic'
    WHEN 'dental' THEN 'clinic'
    WHEN 'lawyer' THEN 'legal'
    ELSE 'appointments'
  END
  WHERE vertical IS NULL AND kind IS NOT NULL AND kind <> 'auto_shop' AND key <> 'advanced_vtech';

-- WhatsApp Business phone_number_id → business, set in the admin UI so a new
-- business doesn't need a redeploy. WA_PHONE_NUMBER_MAP stays as a fallback.
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  phone_number_id TEXT PRIMARY KEY,
  business_type   TEXT NOT NULL,
  label           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_business ON whatsapp_numbers (business_type);

-- An owner asking the Avery team for a phone number (numbers are connected by
-- the operator: Indian numbers need carrier KYC).
CREATE TABLE IF NOT EXISTS number_requests (
  id            TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,
  requested_by  TEXT,                 -- users.email
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | done
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_number_requests_status ON number_requests (status, created_at);

-- A plan marked default is given (with its free trial) to every new business.
-- None is default until the operator marks one, so nothing changes until then.
ALTER TABLE billing_plans ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
