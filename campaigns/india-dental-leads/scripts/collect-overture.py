#!/usr/bin/env python3

import argparse
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import duckdb


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RELEASE = "2026-10-21.0"
TARGET_COUNT = 1000
MIN_CONFIDENCE = 0.55
ALLOWED_CATEGORIES = (
    "dental_clinic",
    "general_dentistry",
    "cosmetic_dentistry",
    "pediatric_dentistry",
    "orthodontics",
    "endodontics",
    "prosthodontics",
    "oral_and_maxillofacial_surgery",
    "periodontics",
)
BLOCKED_NAME_TERMS = (
    "dental lab",
    "dental laboratory",
    "dental supplies",
    "dental supply",
    "dental academy",
    "dental institute",
    "dental college",
    "dental technician",
    "training centre",
    "training center",
)
CITIES = {
    "bengaluru": {
        "name": "Bengaluru",
        "aliases": ("bengaluru", "bangalore"),
        "bbox": (77.35, 77.90, 12.70, 13.25),
        "idPrefix": "blr-dental",
        "postalPrefix": "56",
    },
    "hyderabad": {
        "name": "Hyderabad",
        "aliases": ("hyderabad", "secunderabad"),
        "bbox": (77.95, 78.90, 16.95, 17.85),
        "idPrefix": "hyd-dental",
        "postalPrefix": "50",
    },
    "chennai": {
        "name": "Chennai",
        "aliases": ("chennai", "madras", "tambaram", "avadi"),
        "bbox": (79.70, 80.50, 12.60, 13.50),
        "idPrefix": "maa-dental",
        "postalPrefix": "60",
    },
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--city", choices=[*CITIES, "all"], default="all")
    parser.add_argument("--release", default=os.environ.get("OVERTURE_RELEASE", DEFAULT_RELEASE))
    return parser.parse_args()


def main():
    args = parse_args()
    city_keys = list(CITIES) if args.city == "all" else [args.city]
    connection = duckdb.connect()
    connection.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    summaries = []

    for city_key in city_keys:
        targets, summary = collect_city(connection, city_key, CITIES[city_key], args.release)
        output_directory = ROOT / city_key
        output_directory.mkdir(parents=True, exist_ok=True)
        output_path = output_directory / "targets-1000.json"
        payload = {
            "metadata": {
                "title": f"{CITIES[city_key]['name']} dental clinic research leads",
                "city": CITIES[city_key]["name"],
                "vertical": "dental_clinic",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "targetCount": len(targets),
                "candidateCountBeforeCleaning": summary["candidateCountBeforeCleaning"],
                "qualifiedCountBeforeLimit": summary["qualifiedCountBeforeLimit"],
                "minimumConfidence": MIN_CONFIDENCE,
                "publicBusinessDataOnly": True,
                "outreachSent": False,
                "sendPolicy": "Research only; sendEligible remains false until all email checks and human review pass.",
                "source": {
                    "provider": "Overture Maps Foundation",
                    "dataset": "Places",
                    "release": args.release,
                    "license": "CDLA-Permissive-2.0",
                    "url": "https://docs.overturemaps.org/guides/places/",
                },
            },
            "targets": targets,
        }
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        summaries.append(summary)
        print(f"{CITIES[city_key]['name']}: wrote {len(targets)} targets to {output_path}")

    summary_path = ROOT / "quality-summary.json"
    existing = {}
    if summary_path.exists() and args.city != "all":
        existing = json.loads(summary_path.read_text())
    existing.update({summary["cityKey"]: summary for summary in summaries})
    summary_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n")


def collect_city(connection, city_key, city, release):
    xmin, xmax, ymin, ymax = city["bbox"]
    category_sql = ",".join(f"'{category}'" for category in ALLOWED_CATEGORIES)
    path = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    query = f"""
        SELECT
            id,
            names.primary AS clinic_name,
            taxonomy.primary AS category,
            confidence,
            CAST(addresses AS JSON) AS addresses,
            CAST(websites AS JSON) AS websites,
            CAST(emails AS JSON) AS emails,
            CAST(phones AS JSON) AS phones,
            CAST(socials AS JSON) AS socials,
            CAST(sources AS JSON) AS sources,
            bbox.xmin AS longitude,
            bbox.ymin AS latitude
        FROM read_parquet('{path}', filename=true, hive_partitioning=1)
        WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
          AND bbox.ymin BETWEEN {ymin} AND {ymax}
          AND taxonomy.primary IN ({category_sql})
          AND confidence >= {MIN_CONFIDENCE}
          AND names.primary IS NOT NULL
          AND addresses IS NOT NULL
          AND (phones IS NOT NULL OR websites IS NOT NULL OR emails IS NOT NULL)
    """
    columns = [description[0] for description in connection.execute(query).description]
    rows = [dict(zip(columns, row)) for row in connection.fetchall()]
    normalized = [normalize_record(row, city_key, city) for row in rows]
    eligible = [record for record in normalized if record is not None]
    unique_records = deduplicate(eligible)
    unique_records.sort(key=sort_key)

    if len(unique_records) < TARGET_COUNT:
        raise RuntimeError(
            f"{city['name']} has only {len(unique_records)} qualified unique records; "
            f"refusing to fabricate {TARGET_COUNT}"
        )

    selected = unique_records[:TARGET_COUNT]
    for index, target in enumerate(selected, 1):
        target["id"] = f"{city['idPrefix']}-{index:04d}"
        target["priority"] = index

    summary = summarize(city_key, city["name"], rows, unique_records, selected)
    return selected, summary


def normalize_record(row, city_key, city):
    name = clean_text(row["clinic_name"])
    lowered_name = normalize_text(name)
    if not name or any(term in lowered_name for term in BLOCKED_NAME_TERMS):
        return None

    addresses = json_array(row["addresses"])
    address = choose_address(addresses, city)
    if not address:
        return None

    phones = unique(normalize_phone(value) for value in json_array(row["phones"]))
    websites = unique(normalize_website(value) for value in json_array(row["websites"]))
    emails = unique(normalize_email(value) for value in json_array(row["emails"]))
    socials = unique(str(value).strip() for value in json_array(row["socials"]))
    if not phones and not websites and not emails:
        return None

    providers = unique(
        source.get("provider")
        for source in json_array(row["sources"])
        if isinstance(source, dict) and source.get("provider")
    )
    postcode = clean_text(address.get("postcode")) or postal_code(address.get("freeform"))
    locality = clean_text(address.get("locality")) or city["name"]
    confidence = round(float(row["confidence"]), 4)
    score, reasons = quality_score(
        confidence=confidence,
        category=row["category"],
        address=address,
        phones=phones,
        websites=websites,
        emails=emails,
        providers=providers,
    )
    email_status = "syntax_valid_unverified" if emails else "missing"

    return {
        "overtureId": row["id"],
        "slug": slugify(f"{name}-{locality}-{postcode or city_key}-{row['id'][:8]}"),
        "clinicName": name,
        "vertical": "dental_clinic",
        "specialty": row["category"],
        "city": city["name"],
        "locality": locality,
        "address": clean_text(address.get("freeform")),
        "postcode": postcode,
        "country": address.get("country") or "IN",
        "latitude": round(float(row["latitude"]), 6),
        "longitude": round(float(row["longitude"]), 6),
        "publicPhones": phones,
        "publicWebsites": websites,
        "publicEmails": emails,
        "publicSocials": socials,
        "sourceProviders": providers,
        "sourceConfidence": confidence,
        "qualityScore": score,
        "qualityTier": "A" if score >= 85 else "B" if score >= 70 else "C",
        "scoreReasons": reasons,
        "status": "research_ready",
        "emailPrecheckStatus": email_status,
        "mailboxValidationStatus": "not_checked" if emails else "not_applicable",
        "humanReviewStatus": "pending",
        "consentStatus": "not_contacted",
        "sendEligible": False,
    }


def choose_address(addresses, city):
    valid = [address for address in addresses if isinstance(address, dict) and address.get("freeform")]
    if not valid:
        return None

    def address_rank(address):
        locality = normalize_text(address.get("locality"))
        text = normalize_text(address.get("freeform"))
        city_match = any(alias in locality or alias in text for alias in city["aliases"])
        postcode = clean_text(address.get("postcode")) or postal_code(address.get("freeform"))
        postal_match = bool(postcode and postcode.startswith(city["postalPrefix"]))
        country_match = address.get("country") in (None, "IN")
        return (country_match, city_match, postal_match, len(clean_text(address.get("freeform"))))

    selected = max(valid, key=address_rank)
    if not address_rank(selected)[0]:
        return None
    return selected


def quality_score(confidence, category, address, phones, websites, emails, providers):
    score = round(confidence * 50)
    reasons = [f"Overture confidence {confidence:.2f}"]
    if category in ("dental_clinic", "general_dentistry"):
        score += 10
        reasons.append("core dental category")
    if phones:
        score += 12
        reasons.append("public business phone")
    if websites:
        score += 12
        reasons.append("public website")
    if emails:
        score += 11
        reasons.append("public email awaiting validation")
    if address.get("postcode") or postal_code(address.get("freeform")):
        score += 5
        reasons.append("postal code")
    if len(providers) > 1:
        score += 5
        reasons.append("multiple source providers")
    return min(score, 100), reasons


def deduplicate(records):
    selected = {}
    for record in records:
        key = identity_key(record)
        existing = selected.get(key)
        if existing is None or sort_key(record) < sort_key(existing):
            selected[key] = record
    return list(selected.values())


def identity_key(record):
    name = normalize_text(record["clinicName"])
    address = normalize_text(record["address"])
    postcode = record["postcode"] or ""
    return f"{name}|{address}|{postcode}"


def sort_key(record):
    return (
        -record["qualityScore"],
        -record["sourceConfidence"],
        0 if record["publicEmails"] else 1,
        0 if record["publicWebsites"] else 1,
        normalize_text(record["clinicName"]),
    )


def summarize(city_key, city_name, rows, qualified, selected):
    return {
        "cityKey": city_key,
        "city": city_name,
        "candidateCountBeforeCleaning": len(rows),
        "qualifiedCountBeforeLimit": len(qualified),
        "selectedCount": len(selected),
        "qualityTiers": dict(sorted(Counter(record["qualityTier"] for record in selected).items())),
        "withPublicEmail": sum(bool(record["publicEmails"]) for record in selected),
        "withPublicWebsite": sum(bool(record["publicWebsites"]) for record in selected),
        "withPublicPhone": sum(bool(record["publicPhones"]) for record in selected),
        "sendEligible": sum(record["sendEligible"] for record in selected),
        "duplicateIdentityCount": len(rows) - len(qualified),
    }


def normalize_phone(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 10:
        return f"+91{digits}"
    if len(digits) == 12 and digits.startswith("91"):
        return f"+{digits}"
    return None


def normalize_website(value):
    text = str(value or "").strip()
    if not text:
        return None
    if not re.match(r"^https?://", text, re.I):
        text = f"https://{text}"
    try:
        parsed = urlparse(text)
        return text if parsed.hostname else None
    except ValueError:
        return None


def normalize_email(value):
    email = str(value or "").strip().lower()
    if re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", email):
        return email
    return None


def json_array(value):
    if value is None:
        return []
    parsed = json.loads(value) if isinstance(value, str) else value
    return parsed if isinstance(parsed, list) else []


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_text(value):
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def postal_code(value):
    match = re.search(r"\b([1-9]\d{5})\b", str(value or ""))
    return match.group(1) if match else None


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", clean_text(value).lower()).strip("-")


def unique(values):
    return list(dict.fromkeys(value for value in values if value))


if __name__ == "__main__":
    main()
