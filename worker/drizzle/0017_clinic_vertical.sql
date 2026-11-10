-- Clinic vertical (India launch, workstream G). Everything is additive and
-- unused until a business sets sectors.vertical, so existing businesses are
-- unaffected.

-- Which vertical a business uses (services/verticals.ts). NULL = general,
-- the original auto-shop wording and booking fields.
ALTER TABLE sectors ADD COLUMN vertical TEXT;

-- Bookable people with their own weekly hours: a clinic's doctors.
CREATE TABLE IF NOT EXISTS resources (
  id            TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,
  name          TEXT NOT NULL,              -- "Dr. Ananya Rao"
  role          TEXT,                       -- "General physician"
  hours         TEXT NOT NULL,              -- JSON { "mon": "10am–1pm, 5pm–9pm", … }; omit closed days
  slot_minutes  INTEGER NOT NULL DEFAULT 15,
  fee_cents     INTEGER,                    -- consultation fee, minor units (paise for INR)
  about         TEXT,                       -- languages spoken etc., quoted to callers
  categories    TEXT,                       -- JSON ["DENTAL", …]: product categories this person does; NULL = all
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_business_active ON resources (business_type, is_active);

-- A booking with a resource: who, until when (overlap checks per doctor),
-- and the vertical's extra fields (patient age, new/returning, reason) as JSON.
ALTER TABLE orders ADD COLUMN resource_id TEXT;
ALTER TABLE orders ADD COLUMN resource_name TEXT;
ALTER TABLE orders ADD COLUMN ends_at TEXT;
ALTER TABLE orders ADD COLUMN details TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_resource_scheduled ON orders (resource_id, scheduled_at);
