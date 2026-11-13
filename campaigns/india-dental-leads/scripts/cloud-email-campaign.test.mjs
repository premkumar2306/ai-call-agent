import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMessage,
  classifyReply,
  dateKey,
  graphRequest,
  isBounce,
  listFolderMessages,
  maskEmail,
  selectCandidates,
  validateRecipientDomain
} from './cloud-email-campaign.mjs';

const baseTarget = {
  id: 'blr-dental-0001',
  clinicName: 'Example Dental',
  status: 'research_ready',
  consentStatus: 'not_contacted',
  qualityTier: 'A',
  qualityScore: 95,
  publicEmails: ['hello@example.com'],
  emailDomainValidations: [{ email: 'hello@example.com', status: 'mx_valid' }]
};

test('selectCandidates requires a valid mail domain and removes duplicates', () => {
  const targets = [
    baseTarget,
    { ...baseTarget, id: 'blr-dental-0002' },
    { ...baseTarget, id: 'blr-dental-0003', publicEmails: ['bad@example.net'], emailDomainValidations: [{ email: 'bad@example.net', status: 'domain_invalid' }] }
  ];
  assert.deepEqual(selectCandidates(targets).map((candidate) => candidate.target.id), ['blr-dental-0001']);
});

test('selectCandidates excludes already-sent and blocked mailboxes', () => {
  const targets = [
    baseTarget,
    { ...baseTarget, id: 'blr-dental-0002', publicEmails: ['noreply@example.org'], emailDomainValidations: [{ email: 'noreply@example.org', status: 'mx_valid' }] }
  ];
  assert.equal(selectCandidates(targets, new Set(['hello@example.com'])).length, 0);
});

test('reply and bounce classification is conservative', () => {
  assert.equal(classifyReply({ bodyPreview: 'Yes, please send a demo' }), 'positive');
  assert.equal(classifyReply({ bodyPreview: 'Please remove me' }), 'opt_out');
  assert.equal(classifyReply({ bodyPreview: 'No thank you' }), 'negative');
  assert.equal(classifyReply({ bodyPreview: 'Please call next week' }), 'neutral');
  assert.equal(isBounce({ subject: 'Undeliverable: test' }), true);
});

test('message contains city language and opt-out', () => {
  const message = buildMessage(baseTarget, 'bengaluru');
  assert.match(message.body, /Kannada/);
  assert.match(message.body, /reply no/i);
  assert.match(message.subject, /^\[Avery dental pilot\]/);
});

test('date and masking helpers produce stable output', () => {
  assert.equal(dateKey('2026-11-12T20:00:00Z'), '2026-11-13');
  assert.equal(maskEmail('hello@example.com'), 'he***@example.com');
});

test('graphRequest retries transient Microsoft Graph failures', async () => {
  let attempts = 0;
  const delays = [];
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return new Response('temporarily unavailable', { status: 503 });
    return Response.json({ value: ['message'] });
  };

  const result = await graphRequest('https://graph.microsoft.com/test', 'token', {
    fetchImpl,
    sleep: async (milliseconds) => delays.push(milliseconds),
    maxAttempts: 3
  });

  assert.deepEqual(result, { value: ['message'] });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('listFolderMessages uses bounded small pages', async () => {
  const requestedUrls = [];
  const graphRequestImpl = async (url) => {
    requestedUrls.push(url);
    if (requestedUrls.length === 1) {
      return { value: [{ id: 'one' }], '@odata.nextLink': 'https://graph.microsoft.com/next' };
    }
    return { value: [{ id: 'two' }], '@odata.nextLink': 'https://graph.microsoft.com/ignored' };
  };

  const messages = await listFolderMessages('token', 'sender@example.com', 'inbox', { graphRequestImpl });

  assert.deepEqual(messages, [{ id: 'one' }, { id: 'two' }]);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /\$top=50/);
});

test('validateRecipientDomain accepts live MX and rejects malformed addresses', async () => {
  const valid = await validateRecipientDomain('clinic@example.com', {
    resolveMxImpl: async () => [{ exchange: 'mx.example.com', priority: 10 }]
  });
  const invalid = await validateRecipientDomain('not-an-email');

  assert.deepEqual(valid, {
    status: 'mx_valid',
    domain: 'example.com',
    mxHosts: ['mx.example.com']
  });
  assert.equal(invalid.status, 'invalid_syntax');
});

test('validateRecipientDomain fails closed when DNS has no mail route', async () => {
  const validation = await validateRecipientDomain('clinic@example.invalid', {
    resolveMxImpl: async () => [],
    resolve4Impl: async () => [],
    resolve6Impl: async () => []
  });

  assert.equal(validation.status, 'domain_unresolved');
});

test('validateRecipientDomain does not send through null MX or DNS errors', async () => {
  const nullMx = await validateRecipientDomain('clinic@example.com', {
    resolveMxImpl: async () => [{ exchange: '.', priority: 0 }]
  });
  const dnsError = new Error('temporary DNS failure');
  dnsError.code = 'ETIMEOUT';
  const unavailable = await validateRecipientDomain('clinic@example.com', {
    resolveMxImpl: async () => { throw dnsError; }
  });

  assert.equal(nullMx.status, 'domain_no_mail');
  assert.equal(unavailable.status, 'dns_error');
});
