-- Launch 4: clinic features, each a per-business switch, all OFF by default:
-- procedure-duration booking, recalls, no-show recovery, review requests.
-- Messages use the WhatsApp templates and opt-out from 0021 (PR #97) and run
-- from the hourly cron. Nothing changes for a business without a row here.

CREATE TABLE IF NOT EXISTS clinic_features (
  business_type     TEXT PRIMARY KEY,
  duration_booking  INTEGER NOT NULL DEFAULT 0,  -- slots respect each service's duration and the chair count (sectors.capacity)
  recalls           INTEGER NOT NULL DEFAULT 0,
  recall_months     INTEGER NOT NULL DEFAULT 6,
  recall_category   TEXT,                        -- product category that triggers a recall (e.g. 'cleaning'); NULL = any completed visit
  no_show_recovery  INTEGER NOT NULL DEFAULT 0,
  review_requests   INTEGER NOT NULL DEFAULT 0,
  review_url        TEXT,                        -- the clinic's Google review link (https://g.page/r/… or search.google.com/local/writereview?placeid=…)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- What happened at the visit, marked by staff (Appointments page).
ALTER TABLE orders ADD COLUMN visit_status TEXT;        -- completed | no_show
ALTER TABLE orders ADD COLUMN visit_marked_at INTEGER;  -- unix seconds
ALTER TABLE orders ADD COLUMN no_show_sent_at INTEGER;  -- claimed before sending (once per booking)
ALTER TABLE orders ADD COLUMN no_show_channel TEXT;
ALTER TABLE orders ADD COLUMN review_sent_at INTEGER;
ALTER TABLE orders ADD COLUMN review_channel TEXT;
ALTER TABLE orders ADD COLUMN recall_sent_at INTEGER;
ALTER TABLE orders ADD COLUMN recall_channel TEXT;
