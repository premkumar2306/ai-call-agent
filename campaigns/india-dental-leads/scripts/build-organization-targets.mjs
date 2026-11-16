#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const dataDirectory = join(campaignDirectory, 'data');
const citiesDirectory = join(dataDirectory, 'cities');

const CITY_CONFIG = {
  bengaluru: { name: 'Bengaluru', idPrefix: 'blr-dental-org' },
  chennai: { name: 'Chennai', idPrefix: 'maa-dental-org' },
  hyderabad: { name: 'Hyderabad', idPrefix: 'hyd-dental-org' }
};

const IGNORED_DOMAINS = new Set([
  'apollo247.com',
  'askapollo.com',
  'bit.ly',
  'clinicia.com',
  'eka.care',
  'facebook.com',
  'g.co',
  'goo.gl',
  'google.com',
  'healcon.com',
  'instagram.com',
  'justdial.com',
  'linktr.ee',
  'linkedin.com',
  'localo.site',
  'practo.com',
  'pristyncare.com',
  's10health.com',
  'sites.google.com',
  'wa.me',
  'wixsite.com',
  'wordpress.com',
  'x.com',
  'youtube.com'
]);

const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'hotmail.com',
  'icloud.com',
  'outlook.com',
  'proton.me',
  'rediffmail.com',
  'yahoo.com',
  'yahoo.co.in'
]);

const GENERIC_NAMES = new Set([
  'advanced dental care',
  'apple dental clinic',
  'care dental clinic',
  'care dental hospital',
  'dental care',
  'dental care clinic',
  'dental clinic',
  'dental health care clinic',
  'family dental care',
  'happy teeth dental clinic',
  'smile care dental clinic',
  'smile dental care',
  'smile dental clinic',
  'the dental clinic',
  'the dentist',
  'tooth fairy'
]);

const CHAIN_RULES = [
  chain('clove-dental', 'Clove Dental', ['clovedental.in'], [/\bclove dental\b/i]),
  chain('partha-dental', 'Partha Dental', ['parthadental.com'], [/\bpartha ?dental\b/i]),
  chain('orthosquare', 'Orthosquare', ['orthosquare.com'], [/\borthosquare\b/i]),
  chain('fms-dental', 'FMS Dental Hospitals', ['fmsdental.com'], [/\bfms dental\b/i]),
  chain('apollo-dental', 'Apollo Dental', ['apollodental.in', 'apollowhitedental.com'], [/\bapollo (?:white )?dental\b/i]),
  chain('sabka-dentist', 'Sabka Dentist', ['sabkadentist.com'], [/\bsabka dentist\b/i]),
  chain('dentistree', 'Dentistree Dental Hospitals', ['dentistree.in'], [/\bdentistree\b/i]),
  chain('chennai-dental-centre', 'Chennai Dental Centre', ['chennaidental.com'], [/\bchennai dental centre\b/i]),
  chain('jaws-and-teeth', 'Jaws & Teeth Dental Clinic', ['jawsandteeth.com'], [/\bjaws (?:&|and) teeth\b/i]),
  chain('cure32', 'Cure32 Dental Care', ['cure32.co.in'], [/\bcure ?32\b/i]),
  chain('32-dental-care', '32 Dental Care', ['32dentalcare.org'], [/\b32 ?dental care\b/i]),
  chain('the-dental-specialists', 'The Dental Specialists', ['thedentalspecialists.in'], [/\bthe dental specialists\b/i]),
  chain('dr-gowds-dental', "Dr. Gowd's Dental Hospitals", ['drgowdsdental.com'], [/\bdr\.? ?gowd'?s dental\b/i]),
  chain('tejasri-dental', 'Tejasri Dental', ['tejasridental.com'], [/\btejasri dental\b/i]),
  chain('ardent-dental-care', 'Ardent Dental Care', ['ardentdentalcare.in'], [/\bardent dental care\b/i]),
  chain('finedent', 'Finedent Dental Clinics', ['finedent.in'], [/\bfinedent\b/i]),
  chain('eledent', 'Eledent Hospitals', ['eledenthospitals.com'], [/\beledent\b/i]),
  chain('smile-signature', 'Smile Signature Dental Hospitals', ['dentalsmilesignature.com'], [/\bsmile signature dental\b/i]),
  chain('dentaldost', 'DentalDost', ['dentaldost.com'], [/\bdentaldost\b/i]),
  chain('diva-dental', 'Diva Dental Clinics', ['divadentalclinics.com'], [/\bdiva dental\b/i])
];

export function buildOrganizationPayloads(cityPayloads, generatedAt = new Date().toISOString()) {
  const locations = [];
  for (const [cityKey, payload] of Object.entries(cityPayloads)) {
    if (!CITY_CONFIG[cityKey]) throw new Error(`Unsupported city: ${cityKey}`);
    for (const target of payload.targets ?? []) locations.push({ ...target, cityKey });
  }

  const grouped = new Map();
  for (const location of locations) {
    const identity = organizationIdentity(location);
    const group = grouped.get(identity.key) ?? {
      key: identity.key,
      canonicalName: identity.name,
      locations: []
    };
    group.locations.push(location);
    if (!group.canonicalName && identity.name) group.canonicalName = identity.name;
    grouped.set(identity.key, group);
  }

  const payloads = {};
  for (const [cityKey, config] of Object.entries(CITY_CONFIG)) {
    const organizations = [];
    for (const group of grouped.values()) {
      const cityLocations = group.locations.filter((location) => location.cityKey === cityKey);
      if (cityLocations.length === 0) continue;
      organizations.push(buildOrganization(group, cityLocations, cityKey));
    }

    organizations.sort(compareOrganizations);
    organizations.forEach((organization, index) => {
      organization.id = `${config.idPrefix}-${String(index + 1).padStart(4, '0')}`;
      organization.priority = index + 1;
    });

    payloads[cityKey] = {
      metadata: {
        title: `${config.name} dental organization targets`,
        city: config.name,
        vertical: 'dental_organization',
        generatedAt,
        sourceLocationFile: `data/cities/${cityKey}/targets-1000.json`,
        sourceLocationCount: cityPayloads[cityKey]?.targets?.length ?? 0,
        organizationCount: organizations.length,
        multiLocationOrganizationCount: organizations.filter((organization) => organization.locationCountInDataset >= 2).length,
        priorityPolicy: 'Multi-city and multi-location dental organizations first; premium single locations remain as lower-priority research leads.',
        publicBusinessDataOnly: true,
        outreachSent: false,
        sendPolicy: 'Research only; one organization contact at a time after email checks and human review.'
      },
      organizations
    };
  }

  return payloads;
}

export function organizationIdentity(target) {
  const domains = firstPartyDomains(target);
  const name = target.clinicName ?? '';
  const chainRule = CHAIN_RULES.find((rule) => rule.matches(name, domains));
  if (chainRule) return { key: `chain:${chainRule.key}`, name: chainRule.name };

  const emailDomain = (target.publicEmails ?? [])
    .map((email) => email.split('@')[1]?.toLowerCase())
    .find((domain) => domain && !CONSUMER_EMAIL_DOMAINS.has(domain) && !isIgnoredDomain(domain));
  const domain = domains[0] ?? emailDomain;
  if (domain) return { key: `domain:${domain}`, name: null };

  const normalizedName = normalizeText(name);
  if (normalizedName && !GENERIC_NAMES.has(normalizedName)) {
    return { key: `name:${normalizedName}`, name: name.trim() };
  }
  return { key: `location:${target.overtureId ?? target.id ?? target.slug}`, name: name.trim() };
}

function buildOrganization(group, cityLocations, cityKey) {
  const rankedLocations = [...cityLocations].sort(compareLocations);
  const primaryLocation = rankedLocations[0];
  const cities = [...new Set(group.locations.map((location) => CITY_CONFIG[location.cityKey].name))].sort();
  const publicEmails = rankEmails(unique(group.locations.flatMap((location) => location.publicEmails ?? [])), group).slice(0, 10);
  const publicPhones = unique(group.locations.flatMap((location) => location.publicPhones ?? [])).slice(0, 10);
  const publicWebsites = unique(group.locations.flatMap((location) => location.publicWebsites ?? [])).slice(0, 10);
  const validationByEmail = new Map();
  for (const location of group.locations) {
    for (const validation of location.emailDomainValidations ?? []) {
      if (!validationByEmail.has(validation.email.toLowerCase())) {
        validationByEmail.set(validation.email.toLowerCase(), validation);
      }
    }
  }

  const segment = organizationSegment(group.locations.length, cityLocations.length, cities.length);
  const organizationName = group.canonicalName || inferOrganizationName(group.locations);
  const organizationScore = scoreOrganization({
    segment,
    datasetLocations: group.locations.length,
    cityLocations: cityLocations.length,
    cityCount: cities.length,
    publicEmails,
    publicPhones,
    publicWebsites,
    averageQuality: average(group.locations.map((location) => location.qualityScore ?? 0))
  });

  return {
    slug: slugify(`${organizationName}-${cityKey}`),
    organizationKey: group.key,
    organizationName,
    clinicName: organizationName,
    vertical: 'dental_organization',
    city: CITY_CONFIG[cityKey].name,
    cities,
    segment,
    organizationTier: ['enterprise_chain', 'regional_chain'].includes(segment) ? 'A'
      : ['city_chain', 'growing_group'].includes(segment) ? 'B'
        : 'C',
    qualityTier: organizationScore >= 85 ? 'A' : organizationScore >= 70 ? 'B' : 'C',
    organizationScore,
    qualityScore: organizationScore,
    locationCountInCity: cityLocations.length,
    locationCountInDataset: group.locations.length,
    primaryLocation: locationSummary(primaryLocation),
    locationIds: rankedLocations.map((location) => location.id),
    publicEmails,
    publicPhones,
    publicWebsites,
    emailDomainValidations: publicEmails
      .map((email) => validationByEmail.get(email.toLowerCase()))
      .filter(Boolean),
    buyerRoles: ['Operations Head', 'Customer Experience Head', 'Call Centre Manager', 'Founder or COO'],
    outreachAngle: cityLocations.length > 1
      ? `Overflow and after-hours appointment coverage across ${cityLocations.length} ${CITY_CONFIG[cityKey].name} locations`
      : 'Overflow and after-hours appointment coverage with branch-level reporting',
    status: 'research_ready',
    humanReviewStatus: 'pending',
    consentStatus: 'not_contacted',
    sendEligible: false
  };
}

function organizationSegment(datasetLocations, cityLocations, cityCount) {
  if (datasetLocations >= 25 || (cityCount >= 3 && datasetLocations >= 10)) return 'enterprise_chain';
  if (datasetLocations >= 5 || cityLocations >= 5) return 'regional_chain';
  if (cityLocations >= 3) return 'city_chain';
  if (datasetLocations >= 2 || cityLocations >= 2) return 'growing_group';
  return 'premium_single_location';
}

function scoreOrganization(input) {
  const segmentScore = {
    enterprise_chain: 48,
    regional_chain: 40,
    city_chain: 32,
    growing_group: 24,
    premium_single_location: 8
  }[input.segment];
  const footprint = Math.min(18, input.cityLocations * 3) + Math.min(8, input.cityCount * 2);
  const contacts = (input.publicEmails.length ? 10 : 0)
    + (input.publicPhones.length ? 6 : 0)
    + (input.publicWebsites.length ? 5 : 0);
  const quality = Math.min(10, Math.round(input.averageQuality / 10));
  return Math.min(100, segmentScore + footprint + contacts + quality);
}

function compareOrganizations(left, right) {
  const segmentRank = {
    enterprise_chain: 0,
    regional_chain: 1,
    city_chain: 2,
    growing_group: 3,
    premium_single_location: 4
  };
  return segmentRank[left.segment] - segmentRank[right.segment]
    || right.organizationScore - left.organizationScore
    || right.locationCountInCity - left.locationCountInCity
    || right.locationCountInDataset - left.locationCountInDataset
    || left.organizationName.localeCompare(right.organizationName);
}

function compareLocations(left, right) {
  return contactCoverage(right) - contactCoverage(left)
    || (right.qualityScore ?? 0) - (left.qualityScore ?? 0)
    || (right.sourceConfidence ?? 0) - (left.sourceConfidence ?? 0)
    || left.clinicName.localeCompare(right.clinicName);
}

function contactCoverage(location) {
  return (location.publicEmails?.length ? 4 : 0)
    + (location.publicPhones?.length ? 2 : 0)
    + (location.publicWebsites?.length ? 1 : 0);
}

function locationSummary(location) {
  return {
    locationId: location.id,
    overtureId: location.overtureId,
    clinicName: location.clinicName,
    locality: location.locality,
    address: location.address,
    postcode: location.postcode,
    latitude: location.latitude,
    longitude: location.longitude,
    publicPhones: location.publicPhones ?? [],
    publicWebsites: location.publicWebsites ?? [],
    publicEmails: location.publicEmails ?? [],
    sourceConfidence: location.sourceConfidence,
    qualityScore: location.qualityScore
  };
}

function inferOrganizationName(locations) {
  const names = unique(locations.map((location) => location.clinicName).filter(Boolean));
  if (names.length === 1) return names[0];
  const tokenized = names.map((name) => name.split(/\s+/).filter(Boolean));
  const prefix = [];
  for (let index = 0; index < Math.min(...tokenized.map((tokens) => tokens.length)); index += 1) {
    const token = normalizeText(tokenized[0][index]);
    if (!token || !tokenized.every((tokens) => normalizeText(tokens[index]) === token)) break;
    prefix.push(tokenized[0][index]);
  }
  if (prefix.length >= 2) return prefix.join(' ').replace(/[|,:;-]+$/, '').trim();
  return [...names].sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}

function rankEmails(emails, group) {
  const firstParty = new Set(firstPartyDomains({
    publicWebsites: group.locations.flatMap((location) => location.publicWebsites ?? [])
  }));
  return [...emails].sort((left, right) => emailRank(right, firstParty) - emailRank(left, firstParty) || left.localeCompare(right));
}

function emailRank(email, firstPartyDomains) {
  const [prefix, domain] = email.toLowerCase().split('@');
  let score = firstPartyDomains.has(domain) ? 20 : 0;
  if (/^(appointments?|contact|frontdesk|hello|info|operations?|support)$/.test(prefix)) score += 10;
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) score -= 5;
  return score;
}

function firstPartyDomains(target) {
  return unique((target.publicWebsites ?? [])
    .map(domainFromUrl)
    .filter((domain) => domain && !isIgnoredDomain(domain)));
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isIgnoredDomain(domain) {
  return [...IGNORED_DOMAINS].some((ignored) => domain === ignored || domain.endsWith(`.${ignored}`));
}

function chain(key, name, domains, patterns) {
  return {
    key,
    name,
    matches(clinicName, targetDomains) {
      return targetDomains.some((domain) => domains.includes(domain))
        || patterns.some((pattern) => pattern.test(clinicName));
    }
  };
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').slice(0, 100);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main() {
  const cityPayloads = Object.fromEntries(await Promise.all(Object.keys(CITY_CONFIG).map(async (cityKey) => {
    const path = join(citiesDirectory, cityKey, 'targets-1000.json');
    return [cityKey, JSON.parse(await readFile(path, 'utf8'))];
  })));
  const payloads = buildOrganizationPayloads(cityPayloads);

  for (const [cityKey, payload] of Object.entries(payloads)) {
    const path = join(citiesDirectory, cityKey, 'organization-targets.json');
    await writeFile(path, serializeOrganizationPayload(payload));
    console.log(`${CITY_CONFIG[cityKey].name}: wrote ${payload.organizations.length} organizations to ${path}`);
  }

  const summary = Object.fromEntries(Object.entries(payloads).map(([cityKey, payload]) => [cityKey, {
    city: payload.metadata.city,
    sourceLocationCount: payload.metadata.sourceLocationCount,
    organizationCount: payload.organizations.length,
    multiLocationOrganizationCount: payload.metadata.multiLocationOrganizationCount,
    segments: Object.fromEntries([...new Set(payload.organizations.map((organization) => organization.segment))]
      .map((segment) => [segment, payload.organizations.filter((organization) => organization.segment === segment).length]))
  }]));
  await writeFile(join(dataDirectory, 'organization-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

function serializeOrganizationPayload(payload) {
  const metadata = JSON.stringify(payload.metadata, null, 2).replace(/\n/g, '\n  ');
  const organizations = payload.organizations.map((organization) => `    ${JSON.stringify(organization)}`).join(',\n');
  return `{\n  "metadata": ${metadata},\n  "organizations": [\n${organizations}\n  ]\n}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
