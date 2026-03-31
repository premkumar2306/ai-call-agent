-- ═══════════════════════════════════════════════════════════════════
-- avery-platform — complete schema + seed (ground truth)
-- Run against a fresh D1:
--   wrangler d1 execute avery-platform --remote --file=./schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sectors (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model      TEXT NOT NULL,           -- 'service' | 'retail' | 'mixed'
  categories TEXT NOT NULL,           -- JSON array
  hours      TEXT NOT NULL,           -- JSON object { mon: "9am–5pm", … }
  timezone   TEXT NOT NULL DEFAULT 'America/Chicago',
  currency   TEXT NOT NULL DEFAULT 'USD',
  address    TEXT,
  phone      TEXT,
  website    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id            TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  business_type TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  api_base_url  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                   TEXT NOT NULL PRIMARY KEY,
  business_type        TEXT NOT NULL,
  vendor_id            TEXT NOT NULL REFERENCES vendors(id),
  vendor_name          TEXT NOT NULL,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL,
  type                 TEXT NOT NULL,    -- SERVICE_APPOINTMENT | PHYSICAL_PART | PHYSICAL_ACCESSORY | DIGITAL
  fulfillment_type     TEXT NOT NULL,    -- SERVICE_BOOKING | VENDOR_SHIP | IN_STORE_PICKUP
  description          TEXT NOT NULL,
  price_cents          INTEGER NOT NULL,
  original_price_cents INTEGER NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  image_url            TEXT,
  upsell_product_id    TEXT,
  duration_minutes     INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_bt_active  ON products(business_type, is_active);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT NOT NULL PRIMARY KEY,
  customer_id_hashed TEXT NOT NULL,
  business_type      TEXT NOT NULL,
  product_id         TEXT NOT NULL REFERENCES products(id),
  vendor_name        TEXT NOT NULL,
  product_name       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACCEPTED | COMPLETE | FULFILLING | CANCELLED
  price_cents        INTEGER NOT NULL,
  payment_method     TEXT NOT NULL,
  tracking_number    TEXT,
  scheduled_at       TEXT,
  shipping_line1     TEXT,
  shipping_city      TEXT,
  shipping_state     TEXT,
  shipping_zip       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_bt ON orders(customer_id_hashed, business_type);

CREATE TABLE IF NOT EXISTS transcripts (
  id                 TEXT NOT NULL PRIMARY KEY,
  call_sid           TEXT,
  customer_id_hashed TEXT NOT NULL,
  business_type      TEXT NOT NULL,
  email_sent_to      TEXT,
  turns              TEXT NOT NULL DEFAULT '[]',  -- JSON Turn[]
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcripts_customer_bt ON transcripts(customer_id_hashed, business_type);
CREATE INDEX IF NOT EXISTS idx_transcripts_call_sid    ON transcripts(call_sid);


-- ── Sectors ─────────────────────────────────────────────────────────

INSERT OR IGNORE INTO sectors (key, name, model, categories, hours, timezone, currency, address, phone, website, created_at, updated_at) VALUES

  ('auto_shop', 'Avery Auto', 'mixed',
   '["DIAGNOSTICS","MAINTENANCE","BRAKES","TIRES","BODY_WORK","DETAILING","PARTS"]',
   '{"mon":"7:30am–6pm","tue":"7:30am–6pm","wed":"7:30am–6pm","thu":"7:30am–6pm","fri":"7:30am–6pm","sat":"8am–4pm"}',
   'America/Chicago', 'USD', NULL, NULL, NULL,
   unixepoch(), unixepoch()),

  ('clinic', 'Avery Health', 'service',
   '["PRIMARY_CARE","DENTAL","MENTAL_HEALTH","AESTHETICS","LABS","PREVENTIVE"]',
   '{"mon":"8am–7pm","tue":"8am–7pm","wed":"8am–7pm","thu":"8am–7pm","fri":"8am–7pm","sat":"9am–2pm"}',
   'America/Chicago', 'USD', NULL, NULL, NULL,
   unixepoch(), unixepoch()),

  ('real_estate', 'Avery Realty', 'service',
   '["BUY","RENT","COMMERCIAL","CONSULTATION","VIRTUAL_TOUR"]',
   '{"mon":"9am–7pm","tue":"9am–7pm","wed":"9am–7pm","thu":"9am–7pm","fri":"9am–7pm","sat":"9am–5pm","sun":"11am–4pm"}',
   'America/Chicago', 'USD', NULL, NULL, NULL,
   unixepoch(), unixepoch()),

  ('dental', 'Riverwoods Smiles', 'service',
   '["PREVENTIVE","COSMETIC","RESTORATIVE","ORTHODONTICS","ORAL_SURGERY","EMERGENCY"]',
   '{"mon":"9am–5:30pm","tue":"9am–5:30pm","wed":"9am–5:30pm","thu":"9am–5:30pm","fri":"9am–5:30pm","sat":"9am–2pm"}',
   'America/Chicago', 'USD',
   '1093 S Milwaukee Ave, Riverwoods, IL 60015',
   '(847) 374-5470',
   'https://www.riverwoodssmiles.com',
   unixepoch(), unixepoch()),

  ('advanced_vtech', 'Advanced VTech', 'mixed',
   '["DIAGNOSTICS","MAINTENANCE","BRAKES","TIRES","SUSPENSION","ENGINE","AC_HEATING","FLEET","PARTS"]',
   '{"mon":"7:30am–6pm","tue":"7:30am–6pm","wed":"7:30am–6pm","thu":"7:30am–6pm","fri":"7:30am–6pm","sat":"8am–4pm"}',
   'America/Chicago', 'USD',
   '220 E Aptakisic Rd, Buffalo Grove, IL 60089',
   '(847) 459-4900',
   'https://www.advancedvtech.com',
   unixepoch(), unixepoch());


-- ── Vendors ─────────────────────────────────────────────────────────

INSERT OR IGNORE INTO vendors (id, name, business_type, contact_email, is_active, created_at) VALUES
  ('v-auto-shop',    'Avery Auto — Service Bay',      'auto_shop',      'service@averyauto.com',    1, unixepoch()),
  ('v-auto-parts',   'Avery Auto — Parts Counter',    'auto_shop',      'parts@averyauto.com',      1, unixepoch()),
  ('v-clinic-md',    'Avery Health — Medical',        'clinic',         'medical@averyhealth.com',  1, unixepoch()),
  ('v-clinic-dent',  'Avery Health — Dental',         'clinic',         'dental@averyhealth.com',   1, unixepoch()),
  ('v-clinic-mh',    'Avery Health — Wellness',       'clinic',         'wellness@averyhealth.com', 1, unixepoch()),
  ('v-re-agents',    'Avery Realty — Agents',         'real_estate',    'agents@averyrealty.com',   1, unixepoch()),
  ('v-re-listings',  'Avery Realty — Listings',       'real_estate',    'listings@averyrealty.com', 1, unixepoch()),
  ('v-dental-main',  'Riverwoods Smiles',             'dental',         'info@riverwoodssmiles.com',1, unixepoch()),
  ('v-avtech-shop',  'Advanced VTech — Service Bay',  'advanced_vtech', 'info@advancedvtech.com',   1, unixepoch()),
  ('v-avtech-parts', 'Advanced VTech — Parts Counter','advanced_vtech', 'parts@advancedvtech.com',  1, unixepoch());


-- ── Products: Avery Auto ─────────────────────────────────────────────

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('auto-oil-syn', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Full Synthetic Oil Change', 'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Up to 5 quarts full synthetic oil, OEM filter, tire pressure check, 27-point inspection. Most vehicles done in 45 min.',
   8999, 11999, 1, 'auto-tire-rotate', 45, unixepoch()),

  ('auto-tire-rotate', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Tire Rotation & Balancing', 'TIRES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Rotate all 4 tires, rebalance, adjust pressures, inspect tread depth and sidewalls.',
   5999, 7999, 1, 'auto-alignment', 45, unixepoch()),

  ('auto-alignment', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   '4-Wheel Alignment', 'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Computer-guided 4-wheel alignment. Corrects uneven tire wear, pulling, and steering drift. Includes before/after printout.',
   12900, 15900, 1, NULL, 60, unixepoch()),

  ('auto-brake-front', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Brake Pad Replacement — Front Axle', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads both sides, resurface rotors if within spec, brake fluid top-off, road test. 12-month warranty.',
   27900, 34900, 1, 'auto-brake-rear', 90, unixepoch()),

  ('auto-brake-rear', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Brake Pad Replacement — Rear Axle', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads, rotor inspection, parking brake adjustment. 12-month warranty.',
   24900, 30900, 1, NULL, 90, unixepoch()),

  ('auto-brake-full', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Full Brake Job — All 4 Corners (Bundle)', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Front + rear ceramic pads, resurface or replace all rotors, brake fluid flush. Save $80 vs individual axles.',
   47900, 65900, 1, NULL, 150, unixepoch()),

  ('auto-diag', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Check Engine / Warning Light Diagnostic', 'DIAGNOSTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full OBD-II scan, technician review of fault codes, printed report. Fee waived if repair booked same day.',
   8900, 12000, 1, NULL, 30, unixepoch()),

  ('auto-dent-pdr', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Paintless Dent Repair — up to 3 dents', 'BODY_WORK', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'No paint, no filler — factory finish restored. Works on door dings, hail dents, minor creases. Free estimate on arrival.',
   19900, 29900, 1, 'auto-detail-ext', 120, unixepoch()),

  ('auto-paint-touch', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Paint Touch-Up & Scratch Repair', 'BODY_WORK', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Color-matched touch-up for minor scratches and chips. Blend, polish, and seal. Most jobs completed same day.',
   14900, 19900, 1, 'auto-detail-ext', 60, unixepoch()),

  ('auto-detail-full', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Full Detail — Interior + Exterior', 'DETAILING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Machine polish, clay bar, wax exterior. Deep vacuum, steam clean, leather condition, odor treatment interior. 5–6 hrs.',
   34900, 44900, 1, NULL, 360, unixepoch()),

  ('auto-detail-ext', 'auto_shop', 'v-auto-shop', 'Avery Auto',
   'Exterior Detail & Wax', 'DETAILING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Hand wash, clay bar, machine polish, carnauba wax. UV protection included. Approx 2.5 hours.',
   17900, 24900, 1, NULL, 150, unixepoch()),

  ('auto-part-brk-pads', 'auto_shop', 'v-auto-parts', 'Avery Auto Parts',
   'Bosch QuietCast Ceramic Brake Pads — Front Set', 'PARTS', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   'OE-quality ceramic pads, rubberized shim, hardware kit included. Self-install or add labor at the service bay.',
   6899, 8999, 1, 'auto-brake-front', NULL, unixepoch()),

  ('auto-part-wipers', 'auto_shop', 'v-auto-parts', 'Avery Auto Parts',
   'Bosch ICON Beam Wiper Blades — Pair', 'PARTS', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   'Bracketless beam design, 40% longer life. Free install in the parking lot.',
   3999, 4999, 1, NULL, NULL, unixepoch());


-- ── Products: Avery Health ───────────────────────────────────────────

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('clinic-wellness-exam', 'clinic', 'v-clinic-md', 'Avery Health — Medical',
   'Annual Wellness Exam', 'PRIMARY_CARE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Comprehensive annual physical. Vitals, BMI, cardiovascular review, preventive screening checklist, same-day referrals available.',
   15000, 20000, 1, 'clinic-blood-panel', 60, unixepoch()),

  ('clinic-urgent', 'clinic', 'v-clinic-md', 'Avery Health — Medical',
   'Same-Day Urgent Care Visit', 'PRIMARY_CARE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Minor illnesses and injuries seen same day. No ER needed for colds, UTIs, sprains, minor lacerations, rashes.',
   12500, 17500, 1, NULL, 30, unixepoch()),

  ('clinic-blood-panel', 'clinic', 'v-clinic-md', 'Avery Health — Medical',
   'Comprehensive Blood Panel & Lab Work', 'LABS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'CBC, metabolic panel, lipid panel, A1C, thyroid. Results in 24–48 hours, reviewed with your provider.',
   12000, 16000, 1, NULL, 20, unixepoch()),

  ('clinic-flu-shot', 'clinic', 'v-clinic-md', 'Avery Health — Medical',
   'Flu Vaccination + Mini Wellness Check', 'PREVENTIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Seasonal flu shot with a 10-minute vitals check. Walk-ins welcome; booking skips the wait.',
   4500, 6000, 1, NULL, 15, unixepoch()),

  ('clinic-dental-clean', 'clinic', 'v-clinic-dent', 'Avery Health — Dental',
   'Dental Cleaning & X-Rays', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Prophylaxis cleaning by licensed hygienist, full-mouth X-rays, gum health assessment, personalized care plan.',
   18000, 24000, 1, 'clinic-whitening', 60, unixepoch()),

  ('clinic-whitening', 'clinic', 'v-clinic-dent', 'Avery Health — Dental',
   'In-Office Teeth Whitening', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Zoom! LED whitening system, up to 8 shades in 60 minutes. Custom take-home trays included for maintenance.',
   29900, 39900, 1, NULL, 60, unixepoch()),

  ('clinic-invisalign-consult', 'clinic', 'v-clinic-dent', 'Avery Health — Dental',
   'Invisalign Consultation (Free)', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Free 30-minute consultation with 3D scan, treatment estimate, and financing options. No commitment required.',
   0, 0, 1, 'clinic-whitening', 30, unixepoch()),

  ('clinic-root-canal', 'clinic', 'v-clinic-dent', 'Avery Health — Dental',
   'Root Canal Treatment', 'DENTAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Single-canal root canal by endodontist. Sedation options available. Crown referral included in consult.',
   89900, 119900, 1, NULL, 90, unixepoch()),

  ('clinic-therapy-50', 'clinic', 'v-clinic-mh', 'Avery Health — Wellness',
   'Individual Therapy Session (50 min)', 'MENTAL_HEALTH', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Licensed therapist. CBT, DBT, and mindfulness approaches. Telehealth or in-person. Insurance accepted.',
   15000, 20000, 1, 'clinic-therapy-pkg', 50, unixepoch()),

  ('clinic-therapy-pkg', 'clinic', 'v-clinic-mh', 'Avery Health — Wellness',
   'Therapy Package — 4 Sessions (Save 20%)', 'MENTAL_HEALTH', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Pre-pay 4 individual sessions. Scheduled at your preferred cadence. Non-expiring, transferable.',
   48000, 60000, 1, NULL, 200, unixepoch()),

  ('clinic-botox', 'clinic', 'v-clinic-mh', 'Avery Health — Wellness',
   'Botox Treatment (per area)', 'AESTHETICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Board-certified injector. Forehead, frown lines, or crow''s feet — $14/unit, 20-unit minimum. Results in 7–14 days.',
   28000, 36000, 1, NULL, 30, unixepoch());


-- ── Products: Avery Realty ───────────────────────────────────────────

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('re-buyer-consult', 'real_estate', 'v-re-agents', 'Avery Realty',
   'Free Buyer Consultation', 'CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'One-on-one session with a buyer''s agent. Review budget, must-haves, neighborhoods, and pre-approval checklist. Zero obligation.',
   0, 0, 1, 're-market-analysis', 60, unixepoch()),

  ('re-seller-consult', 'real_estate', 'v-re-agents', 'Avery Realty',
   'Free Seller Consultation & Home Valuation', 'CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Agent visits your home, provides a full CMA (comparative market analysis), and pricing strategy at no cost.',
   0, 0, 1, 're-market-analysis', 60, unixepoch()),

  ('re-market-analysis', 'real_estate', 'v-re-agents', 'Avery Realty',
   'Neighborhood Market Analysis Report', 'CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Detailed PDF: recent sales, price trends, days-on-market, appreciation forecast. Delivered within 48 hours.',
   9900, 14900, 1, NULL, 20, unixepoch()),

  ('re-first-time-workshop', 'real_estate', 'v-re-agents', 'Avery Realty',
   'First-Time Buyer Workshop (Group Session)', 'CONSULTATION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Monthly evening session: mortgage basics, making offers, inspection process, closing costs. Q&A with a lender and agent.',
   4900, 9900, 1, 're-buyer-consult', 120, unixepoch()),

  ('re-tour-residential', 'real_estate', 'v-re-agents', 'Avery Realty',
   'In-Person Property Tour', 'BUY', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Agent-guided tour of up to 3 properties in one session. Flexible same-day scheduling available on most listings.',
   0, 0, 1, 're-buyer-consult', 90, unixepoch()),

  ('re-tour-virtual', 'real_estate', 'v-re-agents', 'Avery Realty',
   'Live Virtual Tour (Video Call)', 'VIRTUAL_TOUR', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Realtor walks through the property live on video. Full Q&A, measurements on request. Available 7 days a week.',
   0, 0, 1, 're-tour-residential', 45, unixepoch()),

  ('re-tour-commercial', 'real_estate', 'v-re-agents', 'Avery Realty',
   'Commercial Space Walk-Through', 'COMMERCIAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Dedicated commercial agent. Zoning review, build-out cost estimate, lease vs buy analysis on request.',
   0, 0, 1, 're-seller-consult', 60, unixepoch()),

  ('re-listing-lakeview-3br', 'real_estate', 'v-re-listings', 'Avery Realty',
   '3BD/2BA Single-Family — Lakeview (For Sale)', 'BUY', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   '1,850 sqft, updated kitchen, hardwood floors, 2-car garage, 0.3 acre lot. Close to top-rated schools. MLS #LV-8821.',
   48500000, 52000000, 1, 're-tour-residential', NULL, unixepoch()),

  ('re-listing-downtown-2br', 'real_estate', 'v-re-listings', 'Avery Realty',
   '2BD/1BA Condo — Downtown (For Rent)', 'RENT', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   '980 sqft, 14th floor, city views, in-unit W/D, gym + rooftop. 12-month lease, pets allowed. MLS #DT-4402.',
   280000, 310000, 1, 're-tour-residential', NULL, unixepoch()),

  ('re-listing-midtown-studio', 'real_estate', 'v-re-listings', 'Avery Realty',
   'Studio Apartment — Midtown (For Rent)', 'RENT', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   '540 sqft, newly renovated, exposed brick, walk to transit. Utilities included. Flexible 6 or 12-month lease.',
   165000, 185000, 1, 're-tour-virtual', NULL, unixepoch()),

  ('re-listing-suburban-4br', 'real_estate', 'v-re-listings', 'Avery Realty',
   '4BD/3BA Suburban Home — Elmwood Park (For Sale)', 'BUY', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   '2,600 sqft, finished basement, pool, 3-car garage, cul-de-sac. 10-min drive to city. MLS #EP-7730.',
   69500000, 74900000, 1, 're-tour-residential', NULL, unixepoch()),

  ('re-listing-office', 'real_estate', 'v-re-listings', 'Avery Realty',
   '1,200 sqft Office Suite — Business District (For Lease)', 'COMMERCIAL', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   'Open floor plan, 2 private offices, kitchenette, high-speed fiber. Class-B building, parking validated. MLS #BD-9910.',
   350000, 420000, 1, 're-tour-commercial', NULL, unixepoch());


-- ── Products: Riverwoods Smiles ──────────────────────────────────────

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('dental-new-patient-exam', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'New Patient Exam (Free)', 'PREVENTIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Comprehensive first-visit exam: oral health review, digital X-rays, gum assessment, and personalized treatment plan — no charge.',
   0, 0, 1, 'dental-cleaning', 60, unixepoch()),

  ('dental-cleaning', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Professional Dental Cleaning & X-Rays', 'PREVENTIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Prophylaxis cleaning by a licensed hygienist, full-mouth digital X-rays, plaque and tartar removal, and a personalized home-care plan.',
   17500, 22000, 1, 'dental-whitening', 60, unixepoch()),

  ('dental-whitening', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'In-Office Teeth Whitening', 'COSMETIC', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Professional-grade whitening — up to 8 shades brighter in a single 60-minute visit, with custom take-home trays for maintenance.',
   59900, 79900, 1, 'dental-veneers-consult', 60, unixepoch()),

  ('dental-veneers-consult', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Smile Design Consultation (Free)', 'COSMETIC', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Free 30-minute consultation covering veneers, Invisalign, and smile makeover options. Includes 3D digital scan and no-obligation estimate.',
   0, 0, 1, 'dental-veneers', 30, unixepoch()),

  ('dental-veneers', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Porcelain Veneers (per tooth)', 'COSMETIC', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Custom-crafted porcelain veneers that correct shape, color, and alignment. Minimally invasive prep with digital design technology.',
   150000, 180000, 1, NULL, 90, unixepoch()),

  ('dental-invisalign', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Invisalign Clear Aligners (Full Treatment)', 'ORTHODONTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full Invisalign treatment with Dr. Rasekh: custom clear aligners, 3D progress tracking, and all follow-up appointments included.',
   450000, 550000, 1, 'dental-whitening', 60, unixepoch()),

  ('dental-crown', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Porcelain Crown', 'RESTORATIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Tooth-colored porcelain crown to restore a damaged or decayed tooth — matched to your natural shade, completed in two visits.',
   130000, 160000, 1, NULL, 90, unixepoch()),

  ('dental-root-canal', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Root Canal Treatment', 'RESTORATIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Single-canal root canal to relieve pain and save a natural tooth. Sedation options available; crown referral coordinated same day.',
   95000, 120000, 1, 'dental-crown', 90, unixepoch()),

  ('dental-implant', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Dental Implant (Single Tooth)', 'RESTORATIVE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Titanium implant post, abutment, and porcelain crown — a permanent tooth replacement that looks and functions like your natural tooth.',
   350000, 420000, 1, NULL, 120, unixepoch()),

  ('dental-extraction', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Tooth Extraction (Simple)', 'ORAL_SURGERY', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Simple extraction under local anesthesia. Post-op care instructions and follow-up included. Wisdom teeth available on referral.',
   25000, 35000, 1, 'dental-implant', 45, unixepoch()),

  ('dental-emergency-exam', 'dental', 'v-dental-main', 'Riverwoods Smiles',
   'Emergency Dental Exam (Same-Day)', 'EMERGENCY', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Same-day emergency visit for toothaches, broken teeth, or lost restorations. Dr. Rasekh will diagnose and relieve pain at first appointment.',
   9900, 15000, 1, 'dental-root-canal', 30, unixepoch());


-- ── Products: Advanced VTech ─────────────────────────────────────────

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('avtech-free-estimate', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Free Vehicle Inspection & Estimate', 'DIAGNOSTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Complimentary multi-point inspection and written estimate — no charge, no commitment.',
   0, 0, 1, 'avtech-diag-scan', 30, unixepoch()),

  ('avtech-diag-scan', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Check Engine / Warning Light Diagnostic', 'DIAGNOSTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full OBD-II scan, technician review of all fault codes, printed report. Fee waived if repair booked same day.',
   8900, 12000, 1, NULL, 30, unixepoch()),

  ('avtech-oil-syn', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Full Synthetic Oil Change', 'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Up to 5 quarts full synthetic oil, OEM filter, tire pressure check, and 27-point safety inspection. Ready in 45 min.',
   8999, 11999, 1, 'avtech-tire-rotate', 45, unixepoch()),

  ('avtech-tune-up', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Engine Tune-Up (Spark Plugs & Filters)', 'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Spark plug replacement, air and cabin filter swap, throttle body clean, ignition system inspection. Restores fuel economy.',
   18900, 24900, 1, 'avtech-diag-scan', 60, unixepoch()),

  ('avtech-tire-rotate', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Tire Rotation & Balancing', 'TIRES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Rotate all 4 tires, rebalance wheels, inspect tread depth and sidewalls, adjust pressures to spec.',
   5999, 7999, 1, 'avtech-alignment', 45, unixepoch()),

  ('avtech-alignment', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   '4-Wheel Alignment', 'TIRES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Computer-guided 4-wheel alignment correcting uneven tire wear, steering pull, and drift. Before-and-after printout.',
   12900, 15900, 1, NULL, 60, unixepoch()),

  ('avtech-brake-front', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Brake Pad Replacement — Front Axle', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads both sides, resurface rotors if within spec, brake fluid top-off, road test. 3-yr/36k-mi TechNet warranty.',
   27900, 34900, 1, 'avtech-brake-rear', 90, unixepoch()),

  ('avtech-brake-rear', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Brake Pad Replacement — Rear Axle', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads, rotor inspection, parking brake adjustment. Same 3-yr/36k-mi TechNet warranty.',
   24900, 30900, 1, NULL, 90, unixepoch()),

  ('avtech-brake-full', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Full Brake Job — All 4 Corners (Bundle)', 'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Front and rear ceramic pads, resurface or replace all rotors, complete brake fluid flush. Save over $80 vs individual axles.',
   47900, 65900, 1, NULL, 150, unixepoch()),

  ('avtech-suspension', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Suspension Inspection & Repair', 'SUSPENSION', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full suspension and steering inspection: shocks, struts, tie rods, ball joints, and bushings. Written estimate before any work.',
   0, 0, 1, 'avtech-alignment', 45, unixepoch()),

  ('avtech-engine-replace', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Engine Replacement (Call for Quote)', 'ENGINE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full engine replacement using remanufactured or OEM units. Includes labor, fluids, and post-install road test. 3-yr/36k warranty.',
   0, 0, 1, NULL, 480, unixepoch()),

  ('avtech-ac-service', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'A/C Inspection & Recharge', 'AC_HEATING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Inspect A/C compressor, hoses, and cabin filter; recharge refrigerant to factory spec. Cool air back in about an hour.',
   14900, 19900, 1, NULL, 60, unixepoch()),

  ('avtech-fleet-consult', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Fleet Service Consultation (Free)', 'FLEET', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Free consultation for commercial fleets: maintenance scheduling, CNG/LPG conversion assessment, and volume pricing.',
   0, 0, 1, 'avtech-fleet-maintenance', 60, unixepoch()),

  ('avtech-fleet-maintenance', 'advanced_vtech', 'v-avtech-shop', 'Advanced VTech',
   'Fleet Maintenance Program (Monthly)', 'FLEET', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Scheduled preventive maintenance for commercial fleets — oil changes, inspections, brakes, priority drop-off. Custom pricing.',
   0, 0, 1, NULL, 60, unixepoch()),

  ('avtech-part-brk-pads', 'advanced_vtech', 'v-avtech-parts', 'Advanced VTech Parts',
   'Ceramic Brake Pads — Front Set', 'PARTS', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   'OE-quality ceramic front brake pads with hardware kit. Pick up at the counter or add installation at the service bay.',
   6899, 8999, 1, 'avtech-brake-front', NULL, unixepoch()),

  ('avtech-part-oil-filter', 'advanced_vtech', 'v-avtech-parts', 'Advanced VTech Parts',
   'OEM Oil Filter', 'PARTS', 'PHYSICAL_PART', 'IN_STORE_PICKUP',
   'OEM-spec oil filter compatible with most domestic and import vehicles. Bundle with a full synthetic oil change.',
   1299, 1799, 1, 'avtech-oil-syn', NULL, unixepoch());


-- ── Products: Buffalo Grove Auto Center ─────────────────────────────
-- Source: https://buffalogroveauto.com | Hours: Mon-Fri 8am-6pm, Sat 8am-12pm

INSERT OR IGNORE INTO sectors (key, name, model, categories, hours, timezone, currency, address, phone, website, created_at, updated_at) VALUES
  ('bg_auto_center', 'Buffalo Grove Auto Center', 'mixed',
   '["DIAGNOSTICS","MAINTENANCE","BRAKES","TIRES","ELECTRICAL","AC_HEATING","CARWASH","DETAILING"]',
   '{"mon":"8am–6pm","tue":"8am–6pm","wed":"8am–6pm","thu":"8am–6pm","fri":"8am–6pm","sat":"8am–12pm"}',
   'America/Chicago', 'USD',
   '55 W Dundee Rd, Buffalo Grove, IL 60089',
   '(847) 419-9949',
   'https://buffalogroveauto.com',
   unixepoch(), unixepoch());

INSERT OR IGNORE INTO vendors (id, name, business_type, contact_email, is_active, created_at) VALUES
  ('v-bgauto-main',  'Buffalo Grove Auto Center',           'bg_auto_center', 'info@buffalogroveauto.com', 1, unixepoch()),
  ('v-bgauto-wash',  'Buffalo Grove Auto Center — Car Wash','bg_auto_center', 'info@buffalogroveauto.com', 1, unixepoch());

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES
  ('bgauto-free-inspect','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Free Multi-Point Vehicle Inspection','DIAGNOSTICS','SERVICE_APPOINTMENT','SERVICE_BOOKING','Complimentary bumper-to-bumper inspection by ASE-certified technicians — brakes, tires, fluids, lights, and more. Written report, no commitment.',0,0,1,'bgauto-diag-scan',30,unixepoch()),
  ('bgauto-diag-scan','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Check Engine / Warning Light Diagnostic','DIAGNOSTICS','SERVICE_APPOINTMENT','SERVICE_BOOKING','Full OBD-II scan and technician review of all fault codes with a printed report. Fee waived if a repair is booked the same day.',8900,12000,1,NULL,30,unixepoch()),
  ('bgauto-oil-syn','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Full Synthetic Oil Change (up to 5 qts)','MAINTENANCE','SERVICE_APPOINTMENT','SERVICE_BOOKING','Full synthetic oil change with OEM filter, tire pressure check, and 27-point safety inspection. ASE-certified, in and out in 30–45 minutes.',3999,5500,1,'bgauto-tire-rotate',45,unixepoch()),
  ('bgauto-battery','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Battery Replacement & Electrical Test','ELECTRICAL','SERVICE_APPOINTMENT','SERVICE_BOOKING','Battery test, replacement with a new OEM-spec battery, and full charging-system check. Price varies by battery; call for exact quote.',0,0,1,NULL,30,unixepoch()),
  ('bgauto-tire-rotate','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Tire Rotation & Balancing','TIRES','SERVICE_APPOINTMENT','SERVICE_BOOKING','Rotate all 4 tires, rebalance wheels, inspect tread depth and sidewalls, and set pressures to spec. Cooper Tire authorized retailer.',4999,6999,1,'bgauto-alignment',45,unixepoch()),
  ('bgauto-alignment','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','4-Wheel Alignment','TIRES','SERVICE_APPOINTMENT','SERVICE_BOOKING','Computer-guided 4-wheel alignment to correct pulling, uneven wear, and steering drift. Before-and-after printout included.',12900,15900,1,NULL,60,unixepoch()),
  ('bgauto-brake-front','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Brake Pad Replacement — Front Axle','BRAKES','SERVICE_APPOINTMENT','SERVICE_BOOKING','Premium ceramic pads both sides, resurface rotors if within spec, brake fluid top-off, and road test. 3-yr/36k-mi warranty. Currently 10% off.',25200,27900,1,'bgauto-brake-rear',90,unixepoch()),
  ('bgauto-brake-rear','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Brake Pad Replacement — Rear Axle','BRAKES','SERVICE_APPOINTMENT','SERVICE_BOOKING','Premium ceramic pads, rotor inspection, and parking brake adjustment. Same 3-yr/36k-mi nationwide warranty.',22500,24900,1,NULL,90,unixepoch()),
  ('bgauto-brake-full','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Full Brake Job — All 4 Corners (Bundle)','BRAKES','SERVICE_APPOINTMENT','SERVICE_BOOKING','Front and rear ceramic pads, resurface or replace all rotors, and a complete brake fluid flush. Saves over $75 vs individual axles.',44900,59900,1,NULL,150,unixepoch()),
  ('bgauto-ac-service','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','A/C Inspection & Recharge','AC_HEATING','SERVICE_APPOINTMENT','SERVICE_BOOKING','Inspect the A/C compressor, condenser, hoses, and cabin filter; recharge refrigerant to factory spec. Cool air back in about an hour.',14900,19900,1,NULL,60,unixepoch()),
  ('bgauto-wash-touchless','bg_auto_center','v-bgauto-wash','Buffalo Grove Auto Center — Car Wash','Touchless Drive-Thru Car Wash','CARWASH','SERVICE_APPOINTMENT','SERVICE_BOOKING','Touchless automatic wash — safe on all finishes, no brushes, no scratches. Includes underbody rinse. Price varies by package; call for details.',0,0,1,'bgauto-detail-full',15,unixepoch()),
  ('bgauto-detail-full','bg_auto_center','v-bgauto-wash','Buffalo Grove Auto Center — Car Wash','Full Detail — Interior & Exterior (By Appointment)','DETAILING','SERVICE_APPOINTMENT','SERVICE_BOOKING','Complete interior deep-clean plus machine-polish, clay bar, and wax exterior. By appointment only; call for pricing.',0,0,1,NULL,300,unixepoch()),
  ('bgauto-transmission','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Transmission Fluid Service','MAINTENANCE','SERVICE_APPOINTMENT','SERVICE_BOOKING','Drain and refill transmission fluid, inspect filter, and check for leaks. Extends transmission life significantly. Call for exact pricing.',0,0,1,NULL,60,unixepoch()),
  ('bgauto-coolant-flush','bg_auto_center','v-bgauto-main','Buffalo Grove Auto Center','Cooling System Flush & Refill','MAINTENANCE','SERVICE_APPOINTMENT','SERVICE_BOOKING','Flush old coolant, clean the system, refill with fresh antifreeze to factory spec. Helps prevent overheating and corrosion.',8900,11900,1,NULL,45,unixepoch()),
  ('bgauto-window-tint','bg_auto_center','v-bgauto-wash','Buffalo Grove Auto Center — Car Wash','Automotive Window Tinting','DETAILING','SERVICE_APPOINTMENT','SERVICE_BOOKING','Professional window film installation — blocks UV, reduces heat, and adds privacy. Price varies by vehicle size; call for a quote.',0,0,1,NULL,120,unixepoch());
