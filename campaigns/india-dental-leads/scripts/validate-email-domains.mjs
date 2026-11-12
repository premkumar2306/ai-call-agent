#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve4, resolve6, resolveMx } from 'node:dns/promises';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const cities = ['bengaluru', 'hyderabad', 'chennai'];
const domainCache = new Map();
const cityPayloads = await Promise.all(cities.map(async (city) => {
  const filePath = join(campaignDirectory, city, 'targets-1000.json');
  return { city, filePath, payload: JSON.parse(await readFile(filePath, 'utf8')) };
}));

await Promise.all(cityPayloads.flatMap(({ payload }) => payload.targets.map(async (target) => {
    const validations = [];
    for (const email of target.publicEmails) {
      const domain = email.split('@')[1];
      validations.push({ email, ...(await validateDomain(domain)) });
    }
    target.emailDomainValidations = validations;
    target.emailPrecheckStatus = summarize(validations, target.publicEmails.length);
    target.sendEligible = false;
})));

for (const { city, filePath, payload } of cityPayloads) {
  payload.metadata.emailDomainValidatedAt = new Date().toISOString();
  payload.metadata.emailValidationWarning = 'Domain checks do not prove mailbox existence; sendEligible remains false.';
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`${city}: ${summarizeCity(payload.targets)}`);
}

const summaryPath = join(campaignDirectory, 'quality-summary.json');
const qualitySummary = JSON.parse(await readFile(summaryPath, 'utf8'));
for (const { city, payload } of cityPayloads) {
  qualitySummary[city].emailDomainStatuses = countStatuses(payload.targets);
  qualitySummary[city].duplicatePublicEmails = duplicateCount(payload.targets.flatMap((target) => target.publicEmails));
  qualitySummary[city].duplicatePublicPhones = duplicateCount(payload.targets.flatMap((target) => target.publicPhones));
}
await writeFile(summaryPath, `${JSON.stringify(qualitySummary, null, 2)}\n`);

async function validateDomain(domain) {
  if (!domainCache.has(domain)) {
    domainCache.set(domain, lookupDomain(domain));
  }
  return domainCache.get(domain);
}

async function lookupDomain(domain) {
  try {
    const records = await resolveMx(domain);
    if (records.length > 0) {
      return { domain, status: 'mx_valid', mxHosts: records.sort((a, b) => a.priority - b.priority).map((record) => record.exchange) };
    }
  } catch (error) {
    if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) {
      return { domain, status: 'domain_unknown', reason: error.code ?? error.message };
    }
  }

  try {
    const addresses = [...await resolve4(domain), ...await resolve6(domain)];
    if (addresses.length > 0) return { domain, status: 'implicit_mx', mxHosts: [domain] };
  } catch (error) {
    if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) {
      return { domain, status: 'domain_unknown', reason: error.code ?? error.message };
    }
  }

  return { domain, status: 'domain_invalid', mxHosts: [] };
}

function summarize(validations, emailCount) {
  if (emailCount === 0) return 'missing';
  if (validations.some((validation) => validation.status === 'domain_invalid')) return 'domain_invalid';
  if (validations.some((validation) => validation.status === 'domain_unknown')) return 'domain_unknown';
  return 'domain_valid_mailbox_unverified';
}

function summarizeCity(targets) {
  return Object.entries(countStatuses(targets)).map(([status, count]) => `${status}=${count}`).join(', ');
}

function countStatuses(targets) {
  const counts = {};
  for (const target of targets) counts[target.emailPrecheckStatus] = (counts[target.emailPrecheckStatus] ?? 0) + 1;
  return counts;
}

function duplicateCount(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}
