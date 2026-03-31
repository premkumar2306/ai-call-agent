-- ═══════════════════════════════════════════════════════════════════
-- BUFFALO GROVE AUTO CENTER
-- Source: https://buffalogroveauto.com | yelp.com | carfax.com
-- 55 W Dundee Rd, Buffalo Grove, IL 60089 | (847) 419-9949
-- Hours: Mon–Fri 8am–6pm, Sat 8am–12pm, Sun closed
-- ASE-certified, 3-yr/36k-mi warranty on all repairs
-- ═══════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO vendors (id, name, business_type, contact_email, is_active, created_at) VALUES
  ('v-bgauto-main',  'Buffalo Grove Auto Center',          'bg_auto_center', 'info@buffalogroveauto.com', 1, unixepoch()),
  ('v-bgauto-wash',  'Buffalo Grove Auto Center — Car Wash','bg_auto_center', 'info@buffalogroveauto.com', 1, unixepoch());

INSERT OR IGNORE INTO products
  (id, business_type, vendor_id, vendor_name, name, category, type, fulfillment_type,
   description, price_cents, original_price_cents, is_active, upsell_product_id, duration_minutes, created_at)
VALUES

  -- ── ENTRY POINT: Free multi-point inspection ────────────────────
  ('bgauto-free-inspect',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Free Multi-Point Vehicle Inspection',
   'DIAGNOSTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Complimentary bumper-to-bumper inspection by ASE-certified technicians — brakes, tires, fluids, lights, and more. Written report, no commitment.',
   0, 0, 1, 'bgauto-diag-scan', 30, unixepoch()),

  -- ── DIAGNOSTICS: Check engine scan (quick win, 30 min) ─────────
  ('bgauto-diag-scan',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Check Engine / Warning Light Diagnostic',
   'DIAGNOSTICS', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full OBD-II scan and technician review of all fault codes with a printed report. Fee waived if a repair is booked the same day.',
   8900, 12000, 1, NULL, 30, unixepoch()),

  -- ── MAINTENANCE: Signature — Synthetic Oil Change ($39.99 promo) ─
  ('bgauto-oil-syn',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Full Synthetic Oil Change (up to 5 qts)',
   'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Full synthetic oil change with OEM filter, tire pressure check, and 27-point safety inspection. ASE-certified, in and out in 30–45 minutes.',
   3999, 5500, 1, 'bgauto-tire-rotate', 45, unixepoch()),

  -- ── MAINTENANCE: Battery replacement ───────────────────────────
  ('bgauto-battery',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Battery Replacement & Electrical Test',
   'ELECTRICAL', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Battery test, replacement with a new OEM-spec battery, and full charging-system check. Price varies by battery; call for exact quote.',
   0, 0, 1, NULL, 30, unixepoch()),

  -- ── TIRES: Rotation & balancing ────────────────────────────────
  ('bgauto-tire-rotate',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Tire Rotation & Balancing',
   'TIRES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Rotate all 4 tires, rebalance wheels, inspect tread depth and sidewalls, and set pressures to spec. Cooper Tire authorized retailer.',
   4999, 6999, 1, 'bgauto-alignment', 45, unixepoch()),

  -- ── TIRES: Alignment (upsell from rotation) ────────────────────
  ('bgauto-alignment',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   '4-Wheel Alignment',
   'TIRES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Computer-guided 4-wheel alignment to correct pulling, uneven wear, and steering drift. Before-and-after printout included.',
   12900, 15900, 1, NULL, 60, unixepoch()),

  -- ── BRAKES: Front axle (mid-range) ─────────────────────────────
  ('bgauto-brake-front',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Brake Pad Replacement — Front Axle',
   'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads both sides, resurface rotors if within spec, brake fluid top-off, and road test. 3-yr/36k-mi warranty. Currently 10% off.',
   25200, 27900, 1, 'bgauto-brake-rear', 90, unixepoch()),

  -- ── BRAKES: Rear axle ──────────────────────────────────────────
  ('bgauto-brake-rear',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Brake Pad Replacement — Rear Axle',
   'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Premium ceramic pads, rotor inspection, and parking brake adjustment. Same 3-yr/36k-mi nationwide warranty.',
   22500, 24900, 1, NULL, 90, unixepoch()),

  -- ── BRAKES: Full 4-corner bundle ───────────────────────────────
  ('bgauto-brake-full',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Full Brake Job — All 4 Corners (Bundle)',
   'BRAKES', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Front and rear ceramic pads, resurface or replace all rotors, and a complete brake fluid flush. Saves over $75 vs individual axles.',
   44900, 59900, 1, NULL, 150, unixepoch()),

  -- ── AC_HEATING: A/C service ────────────────────────────────────
  ('bgauto-ac-service',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'A/C Inspection & Recharge',
   'AC_HEATING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Inspect the A/C compressor, condenser, hoses, and cabin filter; recharge refrigerant to factory spec. Cool air back in about an hour.',
   14900, 19900, 1, NULL, 60, unixepoch()),

  -- ── CARWASH: Touchless drive-thru ──────────────────────────────
  ('bgauto-wash-touchless',
   'bg_auto_center', 'v-bgauto-wash', 'Buffalo Grove Auto Center — Car Wash',
   'Touchless Drive-Thru Car Wash',
   'CARWASH', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Touchless automatic wash — safe on all finishes, no brushes, no scratches. Includes underbody rinse. Price varies by package; call for details.',
   0, 0, 1, 'bgauto-detail-full', 15, unixepoch()),

  -- ── DETAILING: Full interior + exterior (premium) ──────────────
  ('bgauto-detail-full',
   'bg_auto_center', 'v-bgauto-wash', 'Buffalo Grove Auto Center — Car Wash',
   'Full Detail — Interior & Exterior (By Appointment)',
   'DETAILING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Complete interior deep-clean (vacuum, steam, leather condition) plus machine-polish, clay bar, and wax exterior. By appointment only; call for pricing.',
   0, 0, 1, NULL, 300, unixepoch()),

  -- ── MAINTENANCE: Transmission service (premium) ────────────────
  ('bgauto-transmission',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Transmission Fluid Service',
   'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Drain and refill transmission fluid, inspect filter, and check for leaks. Extends transmission life significantly. Call for exact pricing by vehicle.',
   0, 0, 1, NULL, 60, unixepoch()),

  -- ── MAINTENANCE: Cooling system ────────────────────────────────
  ('bgauto-coolant-flush',
   'bg_auto_center', 'v-bgauto-main', 'Buffalo Grove Auto Center',
   'Cooling System Flush & Refill',
   'MAINTENANCE', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Flush old coolant, clean the system, refill with fresh antifreeze to factory spec. Helps prevent overheating and corrosion.',
   8900, 11900, 1, NULL, 45, unixepoch()),

  -- ── TIRES: Window tinting (upsell / specialty) ─────────────────
  ('bgauto-window-tint',
   'bg_auto_center', 'v-bgauto-wash', 'Buffalo Grove Auto Center — Car Wash',
   'Automotive Window Tinting',
   'DETAILING', 'SERVICE_APPOINTMENT', 'SERVICE_BOOKING',
   'Professional window film installation — blocks UV, reduces heat, and adds privacy. Price varies by vehicle size; call for a quote.',
   0, 0, 1, NULL, 120, unixepoch());
