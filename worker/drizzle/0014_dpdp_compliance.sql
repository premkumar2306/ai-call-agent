-- India DPDP Act 2023 support (workstream D): call-start AI/transcription
-- notice, retention, consent audit trail and data-principal requests.
-- Every new setting is NULL by default, which keeps current behaviour for
-- existing businesses (see services/disclosure.ts for how NULL resolves).

-- Call-start notice. NULL = automatic (on for businesses in India, off
-- elsewhere), 1 = always on, 0 = always off.
ALTER TABLE sectors ADD COLUMN ai_disclosure INTEGER;
-- Spoken notice; NULL = the built-in wording (DEFAULT_DISCLOSURE_TEXT).
ALTER TABLE sectors ADD COLUMN disclosure_text TEXT;
-- The business's privacy notice, linked from confirmation texts and the
-- first WhatsApp reply while the notice is on.
ALTER TABLE sectors ADD COLUMN privacy_notice_url TEXT;
-- Days to keep transcripts and staff messages; NULL = keep (no deletion).
ALTER TABLE sectors ADD COLUMN retention_days INTEGER;

-- Lets a caller's messages be found for export/erasure. Older rows are
-- matched by call_sid / callback_phone instead.
ALTER TABLE call_messages ADD COLUMN customer_id_hashed TEXT;
CREATE INDEX IF NOT EXISTS idx_call_messages_customer ON call_messages (customer_id_hashed);

-- The retention job scans transcripts per business by age.
CREATE INDEX IF NOT EXISTS idx_transcripts_business_updated ON transcripts (business_type, updated_at);

-- Audit trail: when the notice was given on each call/conversation.
CREATE TABLE IF NOT EXISTS consent_records (
  id                 TEXT PRIMARY KEY,
  business_type      TEXT NOT NULL,
  channel            TEXT NOT NULL,           -- voice | whatsapp
  call_sid           TEXT,
  customer_id_hashed TEXT,                    -- NULL once the caller's data is erased
  notice_version     TEXT NOT NULL,           -- short hash of notice_text
  notice_text        TEXT NOT NULL,
  played_at          INTEGER NOT NULL,        -- when the notice started playing / was sent
  heard_fully        INTEGER,                 -- 1 played to the end, 0 caller talked over it / hung up, NULL n/a
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_records_business_played ON consent_records (business_type, played_at);
CREATE INDEX IF NOT EXISTS idx_consent_records_customer ON consent_records (customer_id_hashed);

-- Audit trail of data-principal requests handled through the admin API.
CREATE TABLE IF NOT EXISTS data_requests (
  id                 TEXT PRIMARY KEY,
  business_type      TEXT NOT NULL,
  kind               TEXT NOT NULL,           -- export | erase
  customer_id_hashed TEXT NOT NULL,
  summary            TEXT,                    -- JSON counts of what was found / removed
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_requests_business_created ON data_requests (business_type, created_at);
