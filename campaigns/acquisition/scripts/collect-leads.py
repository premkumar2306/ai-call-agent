#!/usr/bin/env python3
"""Build campaigns/acquisition/leads.csv: Bengaluru + Hyderabad dental clinics from the public
Overture Maps Places dataset that are NOT already in campaigns/india-dental-leads or
campaigns/bengaluru-dental-pilot. Public business contact data only; nothing is sent.

    pip install pyarrow   (reads the public S3 bucket anonymously; honours HTTPS_PROXY)
    python3 campaigns/acquisition/scripts/collect-leads.py
"""
import csv, importlib.util, json, re, sys
from pathlib import Path

import os

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs

HERE = Path(__file__).resolve().parent
ACQ = HERE.parent
CAMPAIGNS = ACQ.parent
spec = importlib.util.spec_from_file_location("ov", CAMPAIGNS / "india-dental-leads/scripts/collect-overture.py")
ov = importlib.util.module_from_spec(spec); spec.loader.exec_module(ov)

RELEASE = ov.DEFAULT_RELEASE
MIN_CONFIDENCE = 0.40  # lower than the email campaign's 0.55 because its top 1,000 are excluded
CITY_KEYS = ("bengaluru", "hyderabad")
FIELDS = ["lead_id", "name", "city", "area", "postcode", "website", "public_phone", "public_email",
          "whatsapp", "source_url", "source", "rating", "review_count", "missed_call_signal",
          "demo_slug", "demo_url", "first_line", "quality_tier", "status", "consent_status", "notes"]


# Common pincodes -> neighbourhood (best effort; unknown pincodes fall back to "PIN <code>").
PIN_AREAS = {
    "560001": "MG Road", "560003": "Malleshwaram", "560004": "Basavanagudi", "560008": "HAL 2nd Stage",
    "560010": "Rajajinagar", "560011": "Jayanagar", "560016": "Ramamurthy Nagar", "560017": "Vimanapura",
    "560022": "Yeshwanthpur", "560024": "Hebbal", "560025": "Richmond Town", "560027": "Wilson Garden",
    "560032": "RT Nagar", "560034": "Koramangala", "560035": "Sarjapur Road", "560036": "KR Puram",
    "560037": "Marathahalli", "560038": "Indiranagar", "560040": "Vijayanagar", "560041": "Jayanagar East",
    "560043": "Kalyan Nagar / HRBR", "560047": "Vivek Nagar", "560048": "Mahadevapura", "560054": "Mathikere",
    "560060": "Kengeri", "560064": "Yelahanka", "560066": "Whitefield", "560068": "Bommanahalli",
    "560070": "Banashankari", "560075": "New Thippasandra", "560076": "Bannerghatta Road / BTM",
    "560078": "JP Nagar", "560079": "Basaveshwaranagar", "560085": "Banashankari 3rd Stage",
    "560092": "Sahakar Nagar", "560093": "CV Raman Nagar", "560094": "Sanjaynagar", "560097": "Vidyaranyapura",
    "560098": "RR Nagar", "560100": "Electronic City", "560102": "HSR Layout", "560103": "Bellandur",
    "500003": "Secunderabad", "500016": "Begumpet", "500029": "Himayatnagar", "500032": "Gachibowli",
    "500033": "Jubilee Hills", "500034": "Banjara Hills", "500038": "SR Nagar / Ameerpet", "500044": "Nallakunta",
    "500049": "Miyapur", "500050": "Chandanagar", "500060": "Dilsukhnagar", "500072": "Kukatpally",
    "500074": "LB Nagar", "500081": "Madhapur / HITEC City", "500082": "Somajiguda", "500084": "Kondapur",
    "500085": "KPHB", "500090": "Nizampet / Bachupally",
}


def area_for(r, city):
    loc = (r.get("locality") or "").strip()
    if loc and loc.lower() not in city["aliases"] and not any(c.isdigit() for c in loc):
        return loc
    pc = r.get("postcode") or ""
    return PIN_AREAS.get(pc, f"PIN {pc}" if pc else "")


def norm_name(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def norm_site(s):
    s = (s or "").lower()
    s = re.sub(r"^https?://", "", s); s = re.sub(r"^www\.", "", s)
    return s.split("/")[0]


def existing_keys():
    keys = set()
    files = list(CAMPAIGNS.glob("india-dental-leads/*/targets-*.json")) + list(CAMPAIGNS.glob("bengaluru-dental-pilot/targets-*.json"))
    for f in files:
        data = json.loads(f.read_text())
        for t in data.get("targets", data if isinstance(data, list) else []):
            if t.get("overtureId"): keys.add(("id", t["overtureId"]))
            for p in t.get("publicPhones", []) or ([t["phone"]] if t.get("phone") else []):
                keys.add(("phone", re.sub(r"\D", "", p)[-10:]))
            for e in t.get("publicEmails", []) or ([t["email"]] if t.get("email") else []):
                keys.add(("email", e.lower()))
            for w in t.get("publicWebsites", []) or ([t["website"]] if t.get("website") else []):
                d = norm_site(w)
                if d and not any(x in d for x in ("facebook.", "instagram.", "practo.", "justdial.", "google.", "wa.me")):
                    keys.add(("site", d))
            name = t.get("clinicName") or t.get("name")
            if name: keys.add(("name", norm_name(name) + "|" + (t.get("postcode") or "")))
    return keys


def record_keys(r):
    ks = {("id", r["overtureId"]), ("name", norm_name(r["clinicName"]) + "|" + (r.get("postcode") or ""))}
    ks |= {("phone", re.sub(r"\D", "", p)[-10:]) for p in r["publicPhones"]}
    ks |= {("email", e.lower()) for e in r["publicEmails"]}
    for w in r["publicWebsites"]:
        d = norm_site(w)
        if d and not any(x in d for x in ("facebook.", "instagram.", "practo.", "justdial.", "google.", "wa.me")):
            ks.add(("site", d))
    return ks


def main():
    seen = existing_keys()
    print(f"existing campaign keys: {len(seen)}", file=sys.stderr)
    ov.MIN_CONFIDENCE = MIN_CONFIDENCE
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=proxy or None)
    dataset = ds.dataset(f"overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/", filesystem=s3, format="parquet")
    rows = []
    for ck in CITY_KEYS:
        city = ov.CITIES[ck]
        xmin, xmax, ymin, ymax = city["bbox"]
        f = ((pc.field("bbox", "xmin") >= xmin) & (pc.field("bbox", "xmin") <= xmax)
             & (pc.field("bbox", "ymin") >= ymin) & (pc.field("bbox", "ymin") <= ymax)
             & (pc.field("confidence") >= MIN_CONFIDENCE))
        table = dataset.to_table(filter=f, columns=["id", "names", "taxonomy", "confidence", "addresses",
                                                   "websites", "emails", "phones", "socials", "sources", "bbox"])
        recs = []
        for r in table.to_pylist():
            cat = (r.get("taxonomy") or {}).get("primary")
            name = (r.get("names") or {}).get("primary")
            if cat not in ov.ALLOWED_CATEGORIES or not name: continue
            row = {"id": r["id"], "clinic_name": name, "category": cat, "confidence": r["confidence"],
                   "longitude": r["bbox"]["xmin"], "latitude": r["bbox"]["ymin"]}
            for k in ("addresses", "websites", "emails", "phones", "socials", "sources"):
                row[k] = json.dumps(r.get(k)) if r.get(k) is not None else None
            rec = ov.normalize_record(row, ck, city)
            if rec: recs.append(rec)
        recs = [r for r in recs if r and not any(t in r["clinicName"].lower() for t in ov.BLOCKED_NAME_TERMS)]
        recs.sort(key=lambda r: (-r["qualityScore"], -r["sourceConfidence"]))
        n = 0
        for r in recs:
            if not (r.get("postcode") or "").startswith(city["postalPrefix"]): continue  # e.g. Hosur (TN)
            ks = record_keys(r)
            if ks & seen: continue
            seen |= ks
            n += 1
            fb = next((s for s in r["publicSocials"] if "facebook.com" in s), "")
            rows.append({
                "lead_id": f"acq-{city['idPrefix'].split('-')[0]}-{n:04d}",
                "name": r["clinicName"], "city": city["name"],
                "area": area_for(r, city),
                "postcode": r.get("postcode") or "",
                "website": next(iter(r["publicWebsites"]), ""),
                "public_phone": next(iter(r["publicPhones"]), ""),
                "public_email": next(iter(r["publicEmails"]), ""),
                "whatsapp": "",
                "source_url": fb or next(iter(r["publicWebsites"]), "") or "https://docs.overturemaps.org/guides/places/",
                "source": f"Overture Maps Places {RELEASE} (CDLA-Permissive-2.0) id {r['overtureId']}",
                "rating": "", "review_count": "", "missed_call_signal": "",
                "demo_slug": "", "demo_url": "", "first_line": "",
                "quality_tier": r["qualityTier"], "status": "lead", "consent_status": "not_contacted",
                "notes": "",
            })
        print(f"{city['name']}: {len(recs)} candidates, {n} new after dedupe", file=sys.stderr)
    out = ACQ / "leads.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
    print(f"wrote {len(rows)} leads to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
