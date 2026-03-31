# Add New Vertical

Add a new business to the Avery voice platform using **API calls only** — no CLI, no code changes, works from mobile.

The user may provide:
- A business name + city (e.g. "Riverwoods Smiles, Dentist in Riverwoods Illinois")
- A Google Maps snippet (name, rating, type, city)
- A website URL

---

## Step 1 — Research the business

Use WebSearch and WebFetch to collect **real data**:
- Official website URL
- Exact hours per day (omit closed days)
- Full services list with pricing and durations where published
- Phone number, address, timezone

Search strategy:
1. `WebSearch("{business name} {city} hours services prices site:yelp.com OR site:google.com OR official site")`
2. Fetch official website + `/services` or `/pricing` subpages
3. Use `0` for unknown prices and note "call for pricing" in description

---

## Step 2 — Derive fields

| Field | Rule |
|-------|------|
| `key` | snake_case, e.g. `bg_auto_center`, `riverwoods_smiles` |
| `name` | Exact name from website |
| `model` | `service` / `mixed` / `retail` |
| `categories` | 4–8 UPPER_SNAKE_CASE groupings |
| `hours` | `{ "mon": "9am–5pm", … }` — omit closed days |
| `timezone` | From city/state |

---

## Step 3 — Save sector

```bash
curl -s -X POST https://avery-platform.premkumar-2ba.workers.dev/admin/sectors \
  -H "Content-Type: application/json" \
  -d '{
    "key": "<key>",
    "name": "<Business Name>",
    "model": "service",
    "categories": ["CAT1","CAT2"],
    "hours": { "mon": "9am–5pm" },
    "timezone": "America/Chicago",
    "currency": "USD",
    "address": "<address>",
    "phone": "<phone>",
    "website": "<url>"
  }'
```

Expect `{ "success": true }`.

---

## Step 4 — Save vendor(s)

```bash
curl -s -X POST https://avery-platform.premkumar-2ba.workers.dev/admin/vendors \
  -H "Content-Type: application/json" \
  -d '[
    { "id": "v-<key>-main", "name": "<Business Name>", "business_type": "<key>", "contact_email": "info@example.com" }
  ]'
```

---

## Step 5 — Seed products

Post the full product list in one call:

```bash
curl -s -X POST https://avery-platform.premkumar-2ba.workers.dev/admin/products \
  -H "Content-Type: application/json" \
  -d '[
    {
      "id": "<key>-free-consult",
      "business_type": "<key>",
      "vendor_id": "v-<key>-main",
      "vendor_name": "<Business Name>",
      "name": "Free Consultation",
      "category": "CONSULTATION",
      "type": "SERVICE_APPOINTMENT",
      "fulfillment_type": "SERVICE_BOOKING",
      "description": "One sentence, voice-friendly.",
      "price_cents": 0,
      "original_price_cents": 0,
      "upsell_product_id": null,
      "duration_minutes": 30
    }
  ]'
```

**Product checklist** (aim for 8–12 products):
- [ ] Free entry point (free consult, free estimate, free exam)
- [ ] Quick win ≤ 30 min
- [ ] Signature / most popular service
- [ ] Mid-range service
- [ ] Premium upsell (bundle, package)
- [ ] 2+ upsell chains: A.upsell_product_id → B

**Field rules:**
- `type`: `SERVICE_APPOINTMENT` | `PHYSICAL_PART` | `DIGITAL`
- `fulfillment_type`: `SERVICE_BOOKING` | `VENDOR_SHIP` | `IN_STORE_PICKUP`
- `price_cents`: integer cents ($89 → `8900`), `0` for free/call-for-price
- `duration_minutes`: appointment length in minutes, `null` for physical products
- `description`: one voice-friendly sentence, no markdown

---

## Step 6 — Verify

```bash
curl -s https://avery-platform.premkumar-2ba.workers.dev/sectors
```

The new business appears in the dropdown immediately — no deploy needed.

Also verify products:
```bash
curl -s https://avery-platform.premkumar-2ba.workers.dev/admin/products/<key>
```

---

## Step 7 — Output summary

```
✅ "<Business Name>" (<key>) is live.

Source: <url>
Address: <address> | <phone>
Hours: <summary>

Products: <N> services seeded
Live at: https://avery-platform.premkumar-2ba.workers.dev/sectors

Test flows:
  "What do you offer?"   → search_services
  "What are your hours?" → get_business_hours
  "Book me a [service]"  → search → availability → book_appointment
```
