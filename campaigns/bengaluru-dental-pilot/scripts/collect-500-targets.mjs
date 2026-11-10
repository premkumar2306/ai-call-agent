#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const outputPath = join(campaignDirectory, 'targets-500.json');
const collectedAt = new Date().toISOString();
const healthFinderBase = 'https://healthfinder.in/bangalore/dental-clinics/';
const latrexaUrl = 'https://www.latrexa.com/specialty-directory/dental/bengaluru';

const existingTargets = JSON.parse(await readFile(join(campaignDirectory, 'targets.json'), 'utf8'));
const candidates = existingTargets.map(fromExistingTarget);

for (let page = 1; page <= 17; page += 1) {
  const url = page === 1 ? healthFinderBase : `${healthFinderBase}?page=${page}`;
  const html = await fetchText(url);
  const pageCandidates = parseHealthFinder(html, url);
  candidates.push(...pageCandidates);
  console.log(`HealthFinder page ${page}: ${pageCandidates.length}`);
}

const latrexaHtml = await fetchText(latrexaUrl);
const latrexaCandidates = parseLatrexa(latrexaHtml);
candidates.push(...latrexaCandidates);
console.log(`Latrexa: ${latrexaCandidates.length}`);

const merged = mergeCandidates(candidates)
  .filter(isEligibleDentalTarget)
  .map(finalizeCandidate)
  .sort(compareCandidates);

if (merged.length < 500) {
  throw new Error(`Only ${merged.length} unique public clinic records were found; refusing to fabricate 500`);
}

const targets = merged.slice(0, 500).map((target, index) => ({
  ...target,
  id: `blr-dental-${String(index + 1).padStart(4, '0')}`,
  priority: index + 1
}));

const payload = {
  metadata: {
    title: 'Bengaluru dental clinic outreach targets',
    city: 'Bengaluru',
    vertical: 'dental_clinic',
    generatedAt: collectedAt,
    targetCount: targets.length,
    candidateCountBeforeLimit: merged.length,
    publicBusinessDataOnly: true,
    outreachSent: false,
    sourcePolicy: 'Public business listings only; verify details and obtain WhatsApp opt-in before messaging.',
    sources: [
      {
        provider: 'HealthFinder',
        url: healthFinderBase,
        fields: ['clinicName', 'address', 'publicPhone', 'rating', 'reviewCount']
      },
      {
        provider: 'Latrexa',
        url: latrexaUrl,
        fields: ['clinicName', 'address', 'publicPhone']
      }
    ]
  },
  targets
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${targets.length} targets to ${outputPath}`);

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MogiClinicResearch/1.0 (+public business directory research)',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

function parseHealthFinder(html, pageUrl) {
  const articles = html.match(/<article class="lc"[\s\S]*?<\/article>/gi) ?? [];
  return articles.map((article) => {
    const clinicName = text(match(article, /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i));
    const address = text(match(article, /<span class="addr">([\s\S]*?)<\/span>/i))
      .replace(/^Dental clinic\s*·\s*/i, '');
    const profilePath = decode(match(article, /<h3[^>]*>[\s\S]*?<a href="([^"]+)"/i));
    const phone = normalizePhone(match(article, /href="tel:([^"]+)"/i));
    const rating = numberOrNull(match(article, /<b[^>]*>(\d+(?:\.\d+)?)<\/b>\s*<span class="mute">\(/i));
    const reviewCount = integerOrNull(match(article, /\(([\d,]+)\s+Google reviews\)/i));
    const alt = decode(match(article, /<img[^>]+alt="([^"]+)"/i));
    return {
      clinicName,
      area: inferArea(alt, address),
      address,
      publicPhone: phone,
      leadName: null,
      rating,
      reviewCount,
      reviewLabel: reviewCount === null ? null : 'Google reviews reported by HealthFinder',
      openingHours: null,
      branchCount: null,
      sourceProviders: ['HealthFinder'],
      sourceUrls: [absoluteUrl(profilePath, 'https://healthfinder.in') || pageUrl],
      listingPages: [pageUrl]
    };
  }).filter((candidate) => candidate.clinicName);
}

function parseLatrexa(html) {
  const entries = html.match(/<li>\s*<a href="\/hospital\/[^"]+"[\s\S]*?<\/a>\s*<\/li>/gi) ?? [];
  return entries.map((entry) => {
    const profilePath = decode(match(entry, /<a href="([^"]+)"/i));
    const clinicName = text(match(entry, /<span class="d-block fw-semibold text-dark">([\s\S]*?)<\/span>/i));
    const address = text(match(entry, /<span class="d-block small text-muted mt-2">([\s\S]*?)<\/span>/i));
    const publicPhone = normalizePhone(text(match(entry, /<span class="d-block small text-primary mt-1">([\s\S]*?)<\/span>/i)));
    return {
      clinicName,
      area: inferArea('', address),
      address,
      publicPhone,
      leadName: null,
      rating: null,
      reviewCount: null,
      reviewLabel: null,
      openingHours: null,
      branchCount: null,
      sourceProviders: ['Latrexa'],
      sourceUrls: [absoluteUrl(profilePath, 'https://www.latrexa.com') || latrexaUrl],
      listingPages: [latrexaUrl]
    };
  }).filter((candidate) => candidate.clinicName && candidate.address);
}

function fromExistingTarget(target) {
  return {
    clinicName: target.clinicName,
    area: target.area,
    address: null,
    publicPhone: normalizePhone(target.publicPhone),
    leadName: target.leadName ?? null,
    rating: null,
    reviewCount: target.reviewCount ?? null,
    reviewLabel: target.reviewLabel ?? null,
    openingHours: target.openingHours ?? null,
    branchCount: target.branchCount ?? null,
    sourceProviders: ['Initial research batch'],
    sourceUrls: target.sources ?? [],
    listingPages: []
  };
}

function mergeCandidates(candidates) {
  const result = [];
  const keyToIndex = new Map();

  for (const candidate of candidates) {
    if (!candidate.clinicName) continue;
    const keys = identityKeys(candidate);
    const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index) => index !== undefined);

    if (existingIndex === undefined) {
      const index = result.length;
      result.push(candidate);
      for (const key of keys) keyToIndex.set(key, index);
      continue;
    }

    result[existingIndex] = mergeRecord(result[existingIndex], candidate);
    for (const key of identityKeys(result[existingIndex])) keyToIndex.set(key, existingIndex);
  }
  return result;
}

function mergeRecord(left, right) {
  const useRightAddress = (!left.address && right.address)
    || ((right.address?.length ?? 0) > (left.address?.length ?? 0));
  return {
    ...left,
    clinicName: betterName(left.clinicName, right.clinicName),
    area: left.area || right.area,
    address: useRightAddress ? right.address : left.address,
    publicPhone: left.publicPhone || right.publicPhone,
    leadName: left.leadName || right.leadName,
    rating: left.rating ?? right.rating,
    reviewCount: left.reviewCount ?? right.reviewCount,
    reviewLabel: left.reviewLabel ?? right.reviewLabel,
    openingHours: left.openingHours || right.openingHours,
    branchCount: left.branchCount ?? right.branchCount,
    sourceProviders: unique([...left.sourceProviders, ...right.sourceProviders]),
    sourceUrls: unique([...left.sourceUrls, ...right.sourceUrls]),
    listingPages: unique([...left.listingPages, ...right.listingPages])
  };
}

function finalizeCandidate(candidate) {
  const scoreReasons = [];
  let qualificationScore = 0;

  if (candidate.reviewCount >= 50 && candidate.reviewCount <= 500) {
    qualificationScore += 40;
    scoreReasons.push('50-500 public reviews');
  } else if (candidate.reviewCount > 500) {
    qualificationScore += 20;
    scoreReasons.push('more than 500 public reviews');
  } else if (candidate.reviewCount > 0) {
    qualificationScore += 10;
    scoreReasons.push('public review signal');
  }
  if (candidate.publicPhone) {
    qualificationScore += 25;
    scoreReasons.push('public business phone');
  }
  if (candidate.address) {
    qualificationScore += 10;
    scoreReasons.push('public street address');
  }
  if (candidate.sourceProviders.length > 1) {
    qualificationScore += 10;
    scoreReasons.push('matched across public sources');
  }
  if (candidate.leadName) {
    qualificationScore += 10;
    scoreReasons.push('public lead dentist');
  }
  if (candidate.openingHours) {
    qualificationScore += 5;
    scoreReasons.push('published opening hours');
  }

  return {
    slug: slugify(`${candidate.clinicName}-${candidate.area || postalCode(candidate.address) || 'bengaluru'}`),
    clinicName: candidate.clinicName,
    vertical: 'dental_clinic',
    city: 'Bengaluru',
    area: candidate.area || null,
    address: candidate.address || null,
    publicPhone: candidate.publicPhone || null,
    leadName: candidate.leadName || null,
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    reviewLabel: candidate.reviewLabel,
    openingHours: candidate.openingHours || null,
    branchCount: candidate.branchCount,
    qualificationScore,
    scoreReasons,
    sourceProviders: candidate.sourceProviders,
    sourceUrls: candidate.sourceUrls,
    listingPages: candidate.listingPages,
    status: 'research_pending_verification',
    consentStatus: 'not_contacted',
    demoStatus: 'not_generated',
    needsVerification: true
  };
}

function compareCandidates(left, right) {
  return right.qualificationScore - left.qualificationScore
    || (right.reviewCount ?? -1) - (left.reviewCount ?? -1)
    || left.clinicName.localeCompare(right.clinicName);
}

function isEligibleDentalTarget(candidate) {
  const name = normalizeText(candidate.clinicName);
  const excludedNames = new Set([
    'electronic city phase 1',
    'healthtree services pvt ltd',
    'raddon imaging',
    'ranganath cosmetology center',
    'uttarahalli',
    'vijaya',
    'yelahanka'
  ]);
  return !excludedNames.has(name);
}

function identityKeys(candidate) {
  const name = normalizeText(candidate.clinicName);
  const phone = candidate.publicPhone ?? '';
  const postal = postalCode(candidate.address) ?? '';
  const address = normalizeText(candidate.address ?? '');
  const area = normalizeText(candidate.area ?? '');
  return unique([
    name && postal ? `np:${name}:${postal}` : '',
    phone && postal ? `pp:${phone}:${postal}` : '',
    name && address ? `na:${name}:${address}` : '',
    name && area ? `nl:${name}:${area}` : '',
    name && phone ? `nph:${name}:${phone}` : ''
  ].filter(Boolean));
}

function inferArea(alt, address) {
  const altMatch = alt.match(/,\s*([^,]+),\s*Bangalore\s*$/i);
  if (altMatch) return altMatch[1].trim();
  const beforeCity = address.match(/,\s*([^,]+),\s*Bengaluru(?:,|\s|$)/i);
  if (beforeCity && !/karnataka|bangalore/i.test(beforeCity[1])) return beforeCity[1].trim();
  return null;
}

function normalizePhone(value) {
  if (!value) return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
}

function postalCode(value) {
  return String(value ?? '').match(/\b(5\d{5})\b/)?.[1] ?? null;
}

function betterName(left, right) {
  if (left === left.toUpperCase() && right !== right.toUpperCase()) return right;
  return left.length >= right.length ? left : right;
}

function absoluteUrl(path, origin) {
  if (!path) return null;
  try {
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}

function match(value, pattern) {
  return value.match(pattern)?.[1] ?? '';
}

function text(value) {
  return decode(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decode(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  if (!value) return null;
  const parsed = Number.parseInt(value.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
