import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMessage,
  classifyReply,
  dateKey,
  graphRequest,
  isBounce,
  maskEmail,
  selectCandidates
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
