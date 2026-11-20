#!/usr/bin/env node

import { checkEmailAuth } from './check-email-auth.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve4, resolve6, resolveMx } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const campaignDirectory = resolve(scriptDirectory, '..');
const citiesDirectory = join(campaignDirectory, 'data', 'cities');
const campaignSubjectPrefix = '[Avery clinic operations]';
const campaignSubjectPrefixes = [campaignSubjectPrefix, '[Avery dental pilot]'];
const campaignWhatsAppUrl = 'https://api.whatsapp.com/send/?phone=919944707799&text&type=phone_number&app_absent=0';
const allowedCities = new Set(['bengaluru', 'hyderabad', 'chennai']);
const blockedMailboxPrefixes = new Set([
  'abuse',
  'billing',
  'careers',
  'compliance',
  'hr',
  'jobs',
  'legal',
  'no-reply',
  'noreply',
  'postmaster',
  'privacy',
  'security',
  'webmaster'
]);

export function selectCandidates(targets, sentRecipients = new Set(), sentOrganizations = new Set()) {
  const selected = [];
  const seenEmails = new Set();
  const seenOrganizations = new Set();

  for (const target of targets) {
    if (!['A', 'B'].includes(target.organizationTier ?? target.qualityTier)) continue;
    if (target.status !== 'research_ready') continue;
    if (target.humanReviewStatus !== 'approved') continue;
    if (target.sendEligible !== true) continue;
    if (target.consentStatus !== 'not_contacted') continue;
    if (sentOrganizations.has(target.organizationKey) || seenOrganizations.has(target.organizationKey)) continue;

    const validationByEmail = new Map(
      (target.emailDomainValidations ?? []).map((validation) => [validation.email.toLowerCase(), validation.status])
    );

    for (const rawEmail of target.publicEmails ?? []) {
      const email = rawEmail.toLowerCase();
      const prefix = email.split('@')[0];
      if (!['mx_valid', 'implicit_mx'].includes(validationByEmail.get(email))) continue;
      if (blockedMailboxPrefixes.has(prefix)) continue;
      if (sentRecipients.has(email) || seenEmails.has(email)) continue;
      seenEmails.add(email);
      seenOrganizations.add(target.organizationKey);
      selected.push({ target, email });
      break;
    }
  }

  return selected;
}

export function classifyReply(message) {
  const value = `${message.subject ?? ''} ${message.bodyPreview ?? ''}`.toLowerCase();
  if (/unsubscribe|remove me|stop emailing|do not contact|opt out/.test(value)) return 'opt_out';
  if (/not interested|no thanks|no thank you|don't need|do not need/.test(value)) return 'negative';
  if (/interested|yes|demo|call me|schedule|let's talk|lets talk|more details|pilot/.test(value)) return 'positive';
  return 'neutral';
}

export function isBounce(message) {
  const value = `${message.subject ?? ''} ${message.bodyPreview ?? ''}`.toLowerCase();
  return /undeliverable|delivery has failed|delivery failure|couldn't be delivered|non-delivery report|mailbox full/.test(value);
}

export function dateKey(value, timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function maskEmail(email) {
  const [account, domain] = email.split('@');
  return `${account.slice(0, 2)}***@${domain}`;
}

export async function validateRecipientDomain(email, options = {}) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return { status: 'invalid_syntax', domain: null, mxHosts: [] };
  }

  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
  const resolveMxImpl = options.resolveMxImpl ?? resolveMx;
  const resolve4Impl = options.resolve4Impl ?? resolve4;
  const resolve6Impl = options.resolve6Impl ?? resolve6;

  try {
    const mxRecords = await resolveMxImpl(domain);
    if (mxRecords.some((record) => record.exchange === '.')) {
      return { status: 'domain_no_mail', domain, mxHosts: [] };
    }
    const mxHosts = mxRecords
      .map((record) => record.exchange?.toLowerCase())
      .filter(Boolean);
    if (mxHosts.length > 0) return { status: 'mx_valid', domain, mxHosts };
  } catch (error) {
    if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) {
      return { status: 'dns_error', domain, mxHosts: [] };
    }
  }

  const addressResults = await Promise.allSettled([resolve4Impl(domain), resolve6Impl(domain)]);
  const hasAddress = addressResults.some((result) => result.status === 'fulfilled' && result.value.length > 0);
  return {
    status: hasAddress ? 'implicit_mx' : 'domain_unresolved',
    domain,
    mxHosts: []
  };
}

export function buildMessage(target, city, targeting = {}) {
  const languages = {
    bengaluru: 'English or Hindi',
    hyderabad: 'English, Hindi, or Telugu',
    chennai: 'English or Tamil'
  };
  const organizationName = target.organizationName ?? target.clinicName;
  const locationCount = target.locationCountInCity ?? 1;
  const greeting = organizationName ? `Hi ${organizationName} operations team,` : 'Hi there,';
  const treatmentFocus = Array.isArray(targeting.treatmentFocus) ? targeting.treatmentFocus.filter(Boolean) : [];
  const inquiryFocus = treatmentFocus.length > 0
    ? `${treatmentFocus.join(', ')} enquiries`
    : 'high-value service enquiries';
  return {
    subject: `${campaignSubjectPrefix} appointment-call overflow for ${organizationName}`,
    body: [
      greeting,
      '',
      `${organizationName} has ${locationCount} ${locationCount === 1 ? 'location' : 'locations'} in ${target.city}. We help teams cover overflow and after-hours ${inquiryFocus} in ${languages[city]}, then send the customer a WhatsApp confirmation.`,
      '',
      'The pilot starts with one branch using call forwarding and setup is free. It does not replace the existing number, reception team, or call centre.',
      '',
      'Would the person managing appointment operations be open to reviewing a short branch-level demo?',
      '',
      'WhatsApp Prem:',
      campaignWhatsAppUrl,
      '',
      'Regards,',
      'Prem',
      'Deskzen',
      'premkumar@deskzen.in',
      '',
      'To opt out, reply no.'
    ].join('\n')
  };
}

export function assertSendAllowed(action, campaignPolicy) {
  if (action !== 'send') return;
  if (campaignPolicy.mode !== 'approved' || campaignPolicy.approval?.approvedByPrem !== true || campaignPolicy.approval?.sendActionAllowed !== true) {
    throw new Error('Campaign is held in monitoring-only mode until Prem approves an exact batch.');
  }
}

// Before any send batch: if DKIM or MX is broken, skip the batch (nothing sent, ledger untouched).
export async function sendPreflight(sender, check = checkEmailAuth) {
  const domain = sender.slice(sender.lastIndexOf('@') + 1);
  try {
    const result = await check(domain);
    if (!result.blocked) return { skip: false };
    const failed = result.checks.filter((item) => item.blocker && !item.ok).map((item) => item.name).join(', ');
    return { skip: true, message: `Email auth preflight failed for ${domain} (${failed}); batch skipped, nothing sent. See docs/email-deliverability.md.` };
  } catch (error) {
    return { skip: true, message: `Email auth preflight could not run for ${domain} (${error.message}); batch skipped, nothing sent.` };
  }
}

async function main() {
  const action = process.env.CAMPAIGN_ACTION ?? 'preview';
  const city = process.env.CAMPAIGN_CITY ?? 'bengaluru';
  const maxEmails = Math.min(15, Math.max(1, Number.parseInt(process.env.MAX_EMAILS ?? '15', 10)));
  const outputDirectory = process.env.CAMPAIGN_OUTPUT_DIR ?? join(campaignDirectory, 'runtime');
  const sender = process.env.OUTLOOK_SENDER ?? 'premkumar@deskzen.in';
  const statePath = join(campaignDirectory, 'delivery-ledger.json');
  const campaignPolicy = JSON.parse(await readFile(join(campaignDirectory, 'automation-policy.json'), 'utf8'));

  if (!['preview', 'monitor', 'send'].includes(action)) throw new Error(`Unsupported CAMPAIGN_ACTION: ${action}`);
  assertSendAllowed(action, campaignPolicy);
  if (!allowedCities.has(city)) throw new Error(`Unsupported CAMPAIGN_CITY: ${city}`);
  if (action === 'send' && process.env.CONFIRM_SEND !== 'true' && process.env.AUTOMATION_ENABLED !== 'true') {
    throw new Error('Sending is blocked: confirm_send must be true or DENTAL_CAMPAIGN_ENABLED must be true');
  }

  if (action === 'send') {
    const preflight = await sendPreflight(sender);
    if (preflight.skip) {
      console.log(`::warning::${preflight.message}`);
      return;
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  const payload = JSON.parse(await readFile(join(citiesDirectory, city, 'organization-targets.json'), 'utf8'));
  const campaignState = await readCampaignState(statePath);
  let graphToken = null;
  let sentMessages = [];
  let inboxMessages = [];
  let mailboxReadStatus = action === 'preview' ? 'not_requested' : 'available';
  let mailboxReadError = null;

  if (action !== 'preview') {
    graphToken = await getGraphToken();
    try {
      const mailboxMessages = await listMailboxMessages(graphToken, sender);
      sentMessages = mailboxMessages;
      inboxMessages = mailboxMessages;
    } catch (error) {
      if (action !== 'send' || !isTransientGraphError(error)) throw error;
      mailboxReadStatus = 'degraded';
      mailboxReadError = error.message;
    }
  }

  const campaignSent = sentMessages.filter((message) => campaignSubjectPrefixes.some((prefix) => message.subject?.startsWith(prefix)));
  const sentRecipients = new Set(campaignSent.flatMap((message) => message.toRecipients ?? [])
    .map((recipient) => recipient.emailAddress?.address?.toLowerCase())
    .filter(Boolean));
  const candidates = excludeLedgerRecipients(
    selectCandidates(payload.organizations, sentRecipients, new Set()),
    campaignState.recipientHashes,
    campaignState.organizationHashes
  );
  const replyReport = buildReplyReport(inboxMessages, sentRecipients);
  const today = dateKey(new Date());
  const mailboxSentToday = campaignSent.filter((message) => dateKey(message.sentDateTime ?? message.receivedDateTime) === today).length;
  const ledgerSentToday = campaignState.daily.date === today ? campaignState.daily.count : 0;
  const sentToday = Math.max(mailboxSentToday, ledgerSentToday);
  const remainingToday = Math.max(0, maxEmails - sentToday);
  const result = {
    action,
    city,
    sender,
    generatedAt: new Date().toISOString(),
    mailboxReadStatus,
    mailboxReadError,
    maxEmailsPerDay: maxEmails,
    alreadySentToday: sentToday,
    remainingToday,
    candidateCount: candidates.length,
    sentCount: 0,
    ambiguousCount: 0,
    skippedValidationCount: 0,
    replyCount: replyReport.replies.length,
    bounceCount: replyReport.bounces.length,
    replies: replyReport.replies,
    bounces: replyReport.bounces,
    preview: candidates.slice(0, maxEmails).map(({ target, email }) => ({
      organizationId: target.id,
      organizationName: target.organizationName,
      email: maskEmail(email),
      segment: target.segment,
      locationCountInCity: target.locationCountInCity,
      organizationTier: target.organizationTier,
      organizationScore: target.organizationScore
    })),
    sent: [],
    deliveryErrors: [],
    rejectedByRecipientValidation: []
  };

  if (action === 'send') {
    const domainValidationCache = new Map();

    for (const candidate of candidates) {
      if (result.sentCount + result.ambiguousCount >= remainingToday) break;
      const domain = candidate.email.slice(candidate.email.lastIndexOf('@') + 1);
      if (!domainValidationCache.has(domain)) {
        domainValidationCache.set(domain, validateRecipientDomain(candidate.email));
      }
      const validation = await domainValidationCache.get(domain);
      if (!['mx_valid', 'implicit_mx'].includes(validation.status)) {
        result.skippedValidationCount += 1;
        result.rejectedByRecipientValidation.push({
          organizationId: candidate.target.id,
          email: maskEmail(candidate.email),
          status: validation.status,
          domain: validation.domain
        });
        continue;
      }

      const message = buildMessage(candidate.target, city, campaignPolicy.targeting);
      try {
        await sendMail(graphToken, sender, candidate.email, message);
      } catch (error) {
        if (!isAmbiguousSendError(error)) throw error;
        recordCampaignSend(campaignState, candidate.email, today, candidate.target.organizationKey);
        await writeCampaignState(statePath, campaignState);
        result.ambiguousCount += 1;
        result.deliveryErrors.push({
          organizationId: candidate.target.id,
          organizationName: candidate.target.organizationName,
          email: maskEmail(candidate.email),
          status: error.status,
          message: error.message
        });
        break;
      }
      recordCampaignSend(campaignState, candidate.email, today, candidate.target.organizationKey);
      await writeCampaignState(statePath, campaignState);
      result.sentCount += 1;
      result.sent.push({
        organizationId: candidate.target.id,
        organizationName: candidate.target.organizationName,
        email: maskEmail(candidate.email),
        subject: message.subject
      });
      await delay(1500);
    }
  }

  const jsonPath = join(outputDirectory, 'campaign-report.json');
  const markdownPath = join(outputDirectory, 'campaign-report.md');
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdown(result));
  writeGitHubOutput('sent_count', result.sentCount);
  writeGitHubOutput('reply_count', result.replyCount);
  writeGitHubOutput('bounce_count', result.bounceCount);
  writeGitHubOutput('report_path', markdownPath);
  console.log(renderMarkdown(result));
  if (result.deliveryErrors.length) {
    throw new Error(`Microsoft Graph returned an ambiguous delivery result for ${result.deliveryErrors[0].email}; the recipient was recorded to prevent duplicates`);
  }
}

export function normalizeCampaignState(value = {}) {
  const recipientHashes = [...new Set((value.recipientHashes ?? [])
    .map((hash) => String(hash).trim().toLowerCase())
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash)))].sort();
  const organizationHashes = [...new Set((value.organizationHashes ?? [])
    .map((hash) => String(hash).trim().toLowerCase())
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash)))].sort();
  const date = typeof value.daily?.date === 'string' ? value.daily.date : null;
  const count = Number.isInteger(value.daily?.count) && value.daily.count >= 0 ? value.daily.count : 0;
  return { version: 2, recipientHashes, organizationHashes, daily: { date, count } };
}

export function recordCampaignSend(state, email, date, organizationKey) {
  const recipientHash = hashEmail(email);
  if (!state.recipientHashes.includes(recipientHash)) {
    state.recipientHashes.push(recipientHash);
    state.recipientHashes.sort();
  }
  if (organizationKey) {
    const organizationHash = hashOrganization(organizationKey);
    if (!state.organizationHashes.includes(organizationHash)) {
      state.organizationHashes.push(organizationHash);
      state.organizationHashes.sort();
    }
  }
  if (state.daily.date !== date) state.daily = { date, count: 0 };
  state.daily.count += 1;
  return state;
}

export function hashEmail(email) {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function hashOrganization(organizationKey) {
  return createHash('sha256').update(organizationKey.trim().toLowerCase()).digest('hex');
}

export function excludeLedgerRecipients(candidates, recipientHashes, organizationHashes = []) {
  const ledgerHashes = new Set(recipientHashes);
  const ledgerOrganizationHashes = new Set(organizationHashes);
  return candidates.filter(({ email, target }) => !ledgerHashes.has(hashEmail(email))
    && !ledgerOrganizationHashes.has(hashOrganization(target.organizationKey)));
}

export function isTransientGraphError(error) {
  return /Microsoft Graph request failed: (429|5\d\d)\b/.test(error.message);
}

export function isAmbiguousSendError(error) {
  return error.status === 429 || error.status >= 500;
}

async function readCampaignState(path) {
  try {
    return normalizeCampaignState(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeCampaignState();
    throw error;
  }
}

async function writeCampaignState(path, state) {
  await writeFile(path, `${JSON.stringify(normalizeCampaignState(state), null, 2)}\n`);
}

async function getGraphToken() {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!tenantId || !clientId) throw new Error('MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID are required');

  const form = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  } else {
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) throw new Error('GitHub OIDC is unavailable and MICROSOFT_CLIENT_SECRET is not configured');
    const separator = requestUrl.includes('?') ? '&' : '?';
    const oidcResponse = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent('api://AzureADTokenExchange')}`, {
      headers: { Authorization: `Bearer ${requestToken}` }
    });
    if (!oidcResponse.ok) throw new Error(`GitHub OIDC token request failed: ${oidcResponse.status}`);
    const oidcToken = (await oidcResponse.json()).value;
    form.set('client_assertion', oidcToken);
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  }

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Microsoft token exchange failed: ${body.error_description ?? response.status}`);
  return body.access_token;
}

export async function listFolderMessages(token, sender, folder, options = {}) {
  const select = folder === 'sentitems'
    ? 'subject,toRecipients,sentDateTime'
    : 'subject,from,receivedDateTime';
  const pageSize = options.pageSize ?? 25;
  const maxPages = options.maxPages ?? 4;
  const graphRequestImpl = options.graphRequestImpl ?? graphRequest;
  const folderName = folder === 'sentitems' ? 'SentItems' : 'Inbox';
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/mailFolders('${folderName}')/messages?$select=${select}&$top=${pageSize}`;
  const messages = [];

  for (let page = 0; page < maxPages && url; page += 1) {
    let response;
    try {
      response = await graphRequestImpl(url, token);
    } catch (error) {
      throw new Error(`Microsoft Graph ${folder} read failed: ${error.message}`);
    }
    messages.push(...(response.value ?? []));
    url = response['@odata.nextLink'] ?? null;
  }
  return messages;
}

export async function listMailboxMessages(token, sender, options = {}) {
  const pageSize = options.pageSize ?? 25;
  const maxPages = options.maxPages ?? 4;
  const graphRequestImpl = options.graphRequestImpl ?? graphRequest;
  const select = 'subject,from,toRecipients,sentDateTime,receivedDateTime';
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/messages?$select=${select}&$top=${pageSize}`;
  const messages = [];

  for (let page = 0; page < maxPages && url; page += 1) {
    let response;
    try {
      response = await graphRequestImpl(url, token);
    } catch (error) {
      throw new Error(`Microsoft Graph mailbox read failed: ${error.message}`);
    }
    messages.push(...(response.value ?? []));
    url = response['@odata.nextLink'] ?? null;
  }
  return messages;
}

function buildReplyReport(inboxMessages, sentRecipients) {
  const replies = [];
  const bounces = [];
  for (const message of inboxMessages) {
    if (isBounce(message)) {
      const content = `${message.subject ?? ''} ${message.bodyPreview ?? ''}`.toLowerCase();
      const campaignRelated = campaignSubjectPrefixes.some((prefix) => message.subject?.includes(prefix))
        || [...sentRecipients].some((recipient) => content.includes(recipient));
      if (campaignRelated) bounces.push({ receivedAt: message.receivedDateTime, subject: message.subject ?? 'Delivery failure' });
      continue;
    }
    const sender = message.from?.emailAddress?.address?.toLowerCase();
    if (!sender || !sentRecipients.has(sender)) continue;
    replies.push({
      receivedAt: message.receivedDateTime,
      sender: maskEmail(sender),
      subject: message.subject ?? '',
      classification: classifyReply(message)
    });
  }
  return { replies, bounces };
}

async function sendMail(token, sender, recipient, message) {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: 'Text', content: message.body },
        toRecipients: [{ emailAddress: { address: recipient } }]
      },
      saveToSentItems: true
    })
  });
  if (!response.ok) {
    const error = new Error(`Microsoft Graph sendMail failed for ${maskEmail(recipient)}: ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
}

export async function graphRequest(url, token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const maxAttempts = options.maxAttempts ?? 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return response.json();

    const details = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`Microsoft Graph request failed: ${response.status} ${details}`);
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const backoff = Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter * 1000
      : Math.min(1000 * (2 ** (attempt - 1)), 8000);
    await sleep(backoff);
  }
}

function renderMarkdown(result) {
  const lines = [
    '# Dental email campaign report',
    '',
    `- Action: ${result.action}`,
    `- City: ${result.city}`,
    `- Generated: ${result.generatedAt}`,
    `- Mailbox read status: ${result.mailboxReadStatus}`,
    `- Candidates after safety gates: ${result.candidateCount}`,
    `- Sent today before this run: ${result.alreadySentToday}`,
    `- Sent by this run: ${result.sentCount}`,
    `- Ambiguous delivery attempts: ${result.ambiguousCount}`,
    `- Rejected by recipient validation: ${result.skippedValidationCount}`,
    `- Replies detected: ${result.replyCount}`,
    `- Bounces detected: ${result.bounceCount}`,
    '',
    '## Candidate preview',
    ''
  ];
  for (const candidate of result.preview) lines.push(`- ${candidate.organizationName} (${candidate.email}) — ${candidate.segment}, ${candidate.locationCountInCity} city locations, score ${candidate.organizationScore}`);
  if (result.replies.length) {
    lines.push('', '## Replies', '');
    for (const reply of result.replies) lines.push(`- ${reply.receivedAt}: ${reply.sender} — ${reply.classification} — ${reply.subject}`);
  }
  if (result.bounces.length) {
    lines.push('', '## Delivery failures', '');
    for (const bounce of result.bounces) lines.push(`- ${bounce.receivedAt}: ${bounce.subject}`);
  }
  if (result.deliveryErrors.length) {
    lines.push('', '## Ambiguous delivery attempts', '');
    for (const failure of result.deliveryErrors) lines.push(`- ${failure.organizationName} (${failure.email}) — Graph ${failure.status}; recorded to prevent duplicate retries`);
  }
  return `${lines.join('\n')}\n`;
}

function writeGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
