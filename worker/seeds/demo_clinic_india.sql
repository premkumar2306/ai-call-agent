-- Demo Sehat Family Clinic — a FICTIONAL clinic for demos and synthetic voice
-- tests of the clinic vertical (India launch). Not a real business: the street
-- address is invented (Bengaluru is a real city), there is no real phone line
-- (phone is NULL, so transfers fall back to taking a message), and the doctors
-- are made-up people. Do not point a real phone number at it without replacing
-- this data.
--
-- Clinic vertical: bookings are with a doctor (resources), each with their own
-- OPD hours, slot length and consultation fee. Fees are INR in paise in
-- price_cents / fee_cents (₹500 → 50000). Timezone Asia/Kolkata. OPD is
-- 10am–1pm and 5pm–9pm, Monday to Saturday; Sunday closed.
--
-- Needs migration 0017_clinic_vertical.sql. Apply:
--   npx wrangler d1 execute DB --remote --file seeds/demo_clinic_india.sql
-- then purge KV: sectors_list, products:demo_clinic_india:all
-- (or wait 5 minutes for the caches to expire). Re-running it is safe.

INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, address, phone, website, about, capacity, vertical, is_active, created_at, updated_at)
VALUES (
  'demo_clinic_india',
  'Demo Sehat Family Clinic',
  'service',
  '["CONSULTATION","CHILD_CONSULTATION","DENTAL_CONSULTATION","FOLLOW_UP","DENTAL","HEALTH_CHECK","TESTS","VACCINATION"]',
  '{"mon":"10am–1pm, 5pm–9pm","tue":"10am–1pm, 5pm–9pm","wed":"10am–1pm, 5pm–9pm","thu":"10am–1pm, 5pm–9pm","fri":"10am–1pm, 5pm–9pm","sat":"10am–1pm, 5pm–9pm"}',
  'Asia/Kolkata',
  'INR',
  '12 Demo Lane (fictional address), Indiranagar, Bengaluru, Karnataka 560038',
  NULL,
  NULL,
  'This is a demo clinic used for testing; it is not a real practice. A family clinic with a general physician, a paediatrician and a dentist. Walk-ins are seen after booked patients. Payment at the clinic by cash, UPI or card. Bring any old prescriptions and reports. Free follow-up within 7 days of a paid consultation with the same doctor. No emergency or casualty department, no X-ray, no pharmacy on site. Not stated (don''t claim either way): insurance or cashless claims, home visits, parking.',
  1,
  'clinic',
  1, unixepoch(), unixepoch()
)
ON CONFLICT(key) DO UPDATE SET
  name = excluded.name, model = excluded.model, categories = excluded.categories, hours = excluded.hours,
  timezone = excluded.timezone, currency = excluded.currency, address = excluded.address, phone = excluded.phone,
  website = excluded.website, about = excluded.about, vertical = excluded.vertical, is_active = 1, updated_at = unixepoch();

INSERT INTO vendors (id, name, business_type, contact_email, is_active, created_at)
VALUES ('v-demo-clinic-india', 'Demo Sehat Family Clinic', 'demo_clinic_india', 'demo-clinic@example.com', 1, unixepoch())
ON CONFLICT(id) DO UPDATE SET name = excluded.name, business_type = excluded.business_type;

-- Doctors. hours: OPD timings per day (omit days off). fee_cents: consultation
-- fee in paise. categories: the product categories each one books.
INSERT OR REPLACE INTO resources (id, business_type, name, role, hours, slot_minutes, fee_cents, about, categories, sort_order, is_active, created_at)
VALUES
  ('demo-dr-rao', 'demo_clinic_india', 'Dr. Ananya Rao', 'General physician (MBBS, MD)',
   '{"mon":"10am–1pm, 5pm–9pm","tue":"10am–1pm, 5pm–9pm","wed":"10am–1pm, 5pm–9pm","thu":"10am–1pm, 5pm–9pm","fri":"10am–1pm, 5pm–9pm","sat":"10am–1pm"}',
   15, 50000, 'Speaks English, Hindi and Kannada.',
   '["CONSULTATION","FOLLOW_UP","HEALTH_CHECK","TESTS"]', 1, 1, unixepoch()),
  ('demo-dr-mehta', 'demo_clinic_india', 'Dr. Vikram Mehta', 'Paediatrician (MBBS, DCH)',
   '{"mon":"10am–1pm","tue":"5pm–9pm","wed":"10am–1pm","thu":"5pm–9pm","fri":"10am–1pm","sat":"5pm–9pm"}',
   15, 60000, 'Sees children up to 16. Speaks English, Hindi and Gujarati.',
   '["CHILD_CONSULTATION","FOLLOW_UP","VACCINATION"]', 2, 1, unixepoch()),
  ('demo-dr-khan', 'demo_clinic_india', 'Dr. Farah Khan', 'Dentist (BDS)',
   '{"mon":"5pm–9pm","tue":"10am–1pm, 5pm–9pm","wed":"5pm–9pm","thu":"10am–1pm, 5pm–9pm","fri":"5pm–9pm","sat":"10am–1pm, 5pm–9pm"}',
   30, 40000, 'Speaks English, Hindi and Urdu.',
   '["DENTAL_CONSULTATION","DENTAL","FOLLOW_UP"]', 3, 1, unixepoch());

-- Services. Consultations cost the doctor's fee (price_cents 0 here; the
-- clinic vertical prices them from resources.fee_cents). NULL duration = the
-- doctor's slot length.
INSERT OR REPLACE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('demo-clinic-consult', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'General Consultation', 'CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation with the general physician for adults: fever, cough, cold, stomach upsets, BP, diabetes, general check.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-clinic-child-consult', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Child Consultation', 'CHILD_CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Consultation with the paediatrician for children up to 16.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-clinic-dental-consult', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Dental Consultation', 'DENTAL_CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Dental check-up and consultation with the dentist: tooth pain, sensitivity, bleeding gums, braces advice.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-clinic-follow-up', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Follow-up Visit', 'FOLLOW_UP', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Free follow-up with the same doctor within 7 days of a paid consultation; after that it is charged as a new consultation.',
   0, 0, 1, NULL, NULL, unixepoch()),
  ('demo-clinic-scaling', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Teeth Cleaning (Scaling and Polishing)', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Scaling and polishing of all teeth by the dentist.',
   120000, 120000, 1, NULL, 30, unixepoch()),
  ('demo-clinic-filling', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Tooth-Coloured Filling', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Composite (tooth-coloured) filling for one tooth.',
   150000, 150000, 1, NULL, 30, unixepoch()),
  ('demo-clinic-rct', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Root Canal Treatment', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Root canal treatment, usually over two or three sittings. Price varies by tooth; the dentist quotes it after a dental consultation.',
   0, 0, 1, NULL, 60, unixepoch()),
  ('demo-clinic-health-check', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Basic Health Check-up', 'HEALTH_CHECK', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Doctor consultation with BP, blood sugar (fasting), BMI and a basic blood panel; come fasting for 10 hours.',
   149900, 149900, 1, NULL, 30, unixepoch()),
  ('demo-clinic-ecg', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'ECG', 'TESTS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Resting 12-lead ECG with the report the same day.',
   30000, 30000, 1, NULL, 15, unixepoch()),
  ('demo-clinic-vaccination', 'demo_clinic_india', 'v-demo-clinic-india', 'Demo Sehat Family Clinic',
   'Child Vaccination', 'VACCINATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Vaccinations on the national schedule and optional vaccines, given by the paediatrician. Price varies by vaccine; bring the vaccination card.',
   0, 0, 1, NULL, 15, unixepoch());
