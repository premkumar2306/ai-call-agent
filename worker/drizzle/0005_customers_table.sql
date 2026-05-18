-- Add customers table for real identity management
CREATE TABLE IF NOT EXISTS customers (
  id_hashed TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'BASIC',
  store_credit_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_id_hashed ON customers(id_hashed);
