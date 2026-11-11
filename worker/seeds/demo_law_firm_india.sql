-- Demo Nyaya Legal Associates — a FICTIONAL law firm for demos and synthetic
-- voice tests of the legal vertical. Not a real firm: the address is invented
-- (Pune is a real city), there is no real phone line (phone is NULL, so urgent
-- transfers fall back to taking an urgent message), and the lawyers are
-- made-up people. Do not point a real phone number at it without replacing
-- this data.
--
-- Legal vertical: bookings are consultations with a lawyer (resources), each
-- with their own hours, slot length, consultation fee and practice areas
-- (resource categories). Fees are INR in paise (₹1,000 → 100000). Timezone
-- Asia/Kolkata. Office hours 10am–1pm and 3pm–7pm Monday to Friday,
-- 10am–1pm Saturday; Sunday closed. The AI/recording notice is on by default
-- for legal businesses.
--
-- Needs migrations up to 0018_multi_vertical.sql. Apply:
--   npx wrangler d1 execute DB --remote --file seeds/demo_law_firm_india.sql
-- then purge KV: sectors_list, products:demo_law_firm_india:all
-- (or wait 5 minutes for the caches to expire). Re-running it is safe.

INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, locale, country_code, address, phone, website, about, capacity, vertical, kind, is_active, created_at, updated_at)
VALUES (
  'demo_law_firm_india',
  'Demo Nyaya Legal Associates',
  'service',
  '["FAMILY","PROPERTY","CRIMINAL","CORPORATE","CONSUMER","LABOUR","DOCUMENTS"]',
  '{"mon":"10am–1pm, 3pm–7pm","tue":"10am–1pm, 3pm–7pm","wed":"10am–1pm, 3pm–7pm","thu":"10am–1pm, 3pm–7pm","fri":"10am–1pm, 3pm–7pm","sat":"10am–1pm"}',
  'Asia/Kolkata',
  'INR',
  'en-IN',
  'IN',
  '4th Floor, 21 Demo Chambers (fictional address), FC Road, Pune, Maharashtra 411004',
  NULL,
  NULL,
  'This is a demo law firm used for testing; it is not a real firm. Advocates enrolled with the Bar Council of Maharashtra and Goa. Consultations are in person at the office or by video call. Languages: English, Hindi and Marathi. Bring copies of any notices, agreements or court papers to the consultation. Payment by UPI, card or bank transfer. Not stated (don''t claim either way): legal aid, fixed-fee packages, home visits, parking.',
  1,
  'legal',
  'lawyer',
  1, unixepoch(), unixepoch()
)
ON CONFLICT(key) DO UPDATE SET
  name = excluded.name, model = excluded.model, categories = excluded.categories, hours = excluded.hours,
  timezone = excluded.timezone, currency = excluded.currency, locale = excluded.locale, country_code = excluded.country_code,
  address = excluded.address, phone = excluded.phone, website = excluded.website, about = excluded.about,
  vertical = excluded.vertical, kind = excluded.kind, is_active = 1, updated_at = unixepoch();

INSERT INTO vendors (id, name, business_type, contact_email, is_active, created_at)
VALUES ('v-demo-law-firm-india', 'Demo Nyaya Legal Associates', 'demo_law_firm_india', 'demo-law-firm@example.com', 1, unixepoch())
ON CONFLICT(id) DO UPDATE SET name = excluded.name, business_type = excluded.business_type;

-- Lawyers. hours: when each takes consultations (omit days off). fee_cents:
-- consultation fee in paise. categories: their practice areas.
INSERT OR REPLACE INTO resources (id, business_type, name, role, hours, slot_minutes, fee_cents, about, categories, sort_order, is_active, created_at)
VALUES
  ('demo-adv-kulkarni', 'demo_law_firm_india', 'Adv. Meera Kulkarni', 'Partner — family and property',
   '{"mon":"10am–1pm, 3pm–7pm","tue":"10am–1pm","wed":"3pm–7pm","thu":"10am–1pm, 3pm–7pm","fri":"10am–1pm","sat":"10am–1pm"}',
   30, 150000, 'Speaks English, Hindi and Marathi.',
   '["FAMILY","PROPERTY","DOCUMENTS"]', 1, 1, unixepoch()),
  ('demo-adv-shaikh', 'demo_law_firm_india', 'Adv. Imran Shaikh', 'Advocate — criminal and consumer',
   '{"mon":"3pm–7pm","tue":"10am–1pm, 3pm–7pm","wed":"10am–1pm","thu":"3pm–7pm","fri":"10am–1pm, 3pm–7pm"}',
   30, 100000, 'Speaks English, Hindi and Urdu.',
   '["CRIMINAL","CONSUMER"]', 2, 1, unixepoch()),
  ('demo-adv-iyer', 'demo_law_firm_india', 'Adv. Rohan Iyer', 'Advocate — corporate and labour',
   '{"tue":"3pm–7pm","wed":"10am–1pm, 3pm–7pm","thu":"10am–1pm","fri":"3pm–7pm"}',
   45, 200000, 'Speaks English, Hindi and Tamil.',
   '["CORPORATE","LABOUR","DOCUMENTS"]', 3, 1, unixepoch());

-- Services. Consultations cost the lawyer's fee (price_cents 0; the legal
-- vertical prices practice-area consultations from resources.fee_cents).
-- NULL duration = the lawyer's slot length.
INSERT OR REPLACE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('demo-law-family', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Family Law Consultation', 'FAMILY', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on divorce, maintenance, child custody, domestic violence and other family matters.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-property', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Property Consultation', 'PROPERTY', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on property purchase, title, tenancy, landlord disputes and inheritance.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-criminal', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Criminal Law Consultation', 'CRIMINAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on bail, FIRs, police complaints and criminal cases.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-consumer', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Consumer Complaint Consultation', 'CONSUMER', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on complaints against sellers, builders, banks and service providers.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-corporate', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Business & Corporate Consultation', 'CORPORATE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on company formation, contracts, partnerships and business disputes.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-labour', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Employment & Labour Consultation', 'LABOUR', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation on termination, unpaid salary, gratuity and workplace issues.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-law-notary', 'demo_law_firm_india', 'v-demo-law-firm-india', 'Demo Nyaya Legal Associates',
   'Document Drafting Appointment (rent agreement, affidavit)', 'DOCUMENTS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Drafting a rent agreement or affidavit. Bring ID proof for everyone signing. Stamp duty and registration charges are extra.',
   250000, 250000, 1, NULL, 30, unixepoch());
