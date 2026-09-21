#!/usr/bin/env python3
"""
South-India-friendly startup domain finder.

What it does:
1. Generates short, pronounceable brand candidates from familiar South-Indian/Tamil-friendly roots.
2. Checks .com availability using Verisign RDAP.
3. Saves available and taken names to CSV.

Run:
    python domain_finder.py

Optional:
    python domain_finder.py --limit 300 --sleep 0.25
"""

import argparse
import csv
import itertools
import re
import time
from urllib import request, error

ROOTS = [
    "pesu", "pechu", "oli", "namma", "kural", "sol", "solli", "vaa",
    "kelvi", "mozhi", "isai", "anbu", "nalla", "muthu", "nila", "vani",
    "thuli", "thendral", "aruvi", "min", "nira", "savi", "ovi", "vaya"
]

SUFFIXES = [
    "", "go", "now", "call", "talk", "voice", "bot", "app", "ai", "hq",
    "ly", "io", "on", "one", "up", "pro", "hub"
]

PREFIXES = [
    "", "get", "use", "hey", "my"
]

def normalize(name: str) -> str:
    name = name.lower()
    name = re.sub(r"[^a-z0-9]", "", name)
    return name

def generate_candidates():
    seen = set()

    # Root + suffix
    for root, suffix in itertools.product(ROOTS, SUFFIXES):
        name = normalize(root + suffix)
        if 5 <= len(name) <= 12 and name not in seen:
            seen.add(name)
            yield name

    # Prefix + root
    for prefix, root in itertools.product(PREFIXES, ROOTS):
        name = normalize(prefix + root)
        if 5 <= len(name) <= 12 and name not in seen:
            seen.add(name)
            yield name

    # Two short roots
    short_roots = [r for r in ROOTS if len(r) <= 5]
    for a, b in itertools.permutations(short_roots, 2):
        name = normalize(a + b)
        if 6 <= len(name) <= 11 and name not in seen:
            seen.add(name)
            yield name

def score_name(name: str) -> int:
    """Higher is better: short, vowel-rich, avoids awkward clusters."""
    score = 100

    # Prefer 6-9 chars
    score -= abs(len(name) - 7) * 4

    # Penalize numbers
    if any(c.isdigit() for c in name):
        score -= 30

    # Reward vowel balance
    vowels = sum(c in "aeiou" for c in name)
    ratio = vowels / max(len(name), 1)
    if 0.35 <= ratio <= 0.6:
        score += 10

    # Penalize ugly consonant clusters
    if re.search(r"[^aeiou]{4,}", name):
        score -= 20

    # Prefer familiar voice/conversation roots
    for root in ("pesu", "pechu", "oli", "namma", "kural", "mozhi", "vani"):
        if root in name:
            score += 8
            break

    return score

def com_available(domain: str):
    """
    Verisign RDAP behavior:
    200 = registered
    404 = not found -> likely available
    """
    url = f"https://rdap.verisign.com/com/v1/domain/{domain}"
    req = request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 domain-finder/1.0"}
    )
    try:
        with request.urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                return False, "registered"
    except error.HTTPError as e:
        if e.code == 404:
            return True, "available"
        return None, f"http_{e.code}"
    except Exception as e:
        return None, f"error:{type(e).__name__}"

    return None, "unknown"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--top", type=int, default=25)
    args = parser.parse_args()

    candidates = list(generate_candidates())
    candidates.sort(key=score_name, reverse=True)
    candidates = candidates[:args.limit]

    rows = []
    print(f"Checking {len(candidates)} candidate .com domains...\n")

    for i, name in enumerate(candidates, start=1):
        domain = f"{name}.com"
        available, status = com_available(domain)
        score = score_name(name)

        rows.append({
            "name": name,
            "domain": domain,
            "score": score,
            "available": available,
            "status": status
        })

        marker = "✅" if available else ("❌" if available is False else "⚠️")
        print(f"{i:03d}. {marker} {domain:24} score={score} status={status}")
        time.sleep(args.sleep)

    with open("domain_results.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["name", "domain", "score", "available", "status"]
        )
        writer.writeheader()
        writer.writerows(rows)

    available_rows = [r for r in rows if r["available"] is True]
    available_rows.sort(key=lambda r: r["score"], reverse=True)

    print("\nTOP AVAILABLE DOMAINS")
    print("=" * 50)
    for row in available_rows[:args.top]:
        print(f'{row["domain"]:24} score={row["score"]}')

    print("\nSaved full results to domain_results.csv")
    print("Before buying: also search the name for existing companies and trademarks.")

if __name__ == "__main__":
    main()
