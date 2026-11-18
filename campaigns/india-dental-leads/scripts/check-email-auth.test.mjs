import assert from 'node:assert/strict';
import test from 'node:test';

import { checkEmailAuth, formatChecks } from './check-email-auth.mjs';

function resolver(records) {
  const get = (key) => {
    if (!(key in records)) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    return records[key];
  };
  return {
    resolveTxt: async (name) => get(`TXT ${name}`),
    resolveCname: async (name) => get(`CNAME ${name}`),
    resolveMx: async (name) => get(`MX ${name}`)
  };
}

const good = {
  'TXT deskzen.in': [['v=spf1 include:spf.protection.outlook.com -all']],
  'TXT _dmarc.deskzen.in': [['v=DMARC1; p=quarantine']],
  'CNAME selector1._domainkey.deskzen.in': ['selector1-deskzen-in._domainkey.t.onmicrosoft.com'],
  'CNAME selector2._domainkey.deskzen.in': ['selector2-deskzen-in._domainkey.t.onmicrosoft.com'],
  'MX deskzen.in': [{ exchange: 'deskzen-in.mail.protection.outlook.com', priority: 0 }]
};

test('all records good', async () => {
  const result = await checkEmailAuth('deskzen.in', resolver(good));
  assert.equal(result.blocked, false);
  assert.ok(result.checks.every((check) => check.ok));
});

test('missing DKIM blocks', async () => {
  const { 'CNAME selector1._domainkey.deskzen.in': _a, 'CNAME selector2._domainkey.deskzen.in': _b, ...rest } = good;
  const result = await checkEmailAuth('deskzen.in', resolver(rest));
  assert.equal(result.blocked, true);
  assert.match(formatChecks('deskzen.in', result), /✗ DKIM selector1/);
});

test('extra MX blocks', async () => {
  const result = await checkEmailAuth('deskzen.in', resolver({
    ...good,
    'MX deskzen.in': [...good['MX deskzen.in'], { exchange: 'mail.domain-com.', priority: 10 }]
  }));
  assert.equal(result.blocked, true);
});

test('SPF problems and DMARC policy are warnings, not blockers', async () => {
  const result = await checkEmailAuth('deskzen.in', resolver({
    ...good,
    'TXT deskzen.in': [['v=spf1 -all'], ['v=spf1 include:spf.protection.outlook.com -all']],
    'TXT _dmarc.deskzen.in': [['v=DMARC1; p=none']]
  }));
  assert.equal(result.blocked, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[1].detail, /p=none/);
});

test('real resolver errors propagate', async () => {
  await assert.rejects(checkEmailAuth('deskzen.in', {
    resolveTxt: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); },
    resolveCname: async () => [],
    resolveMx: async () => []
  }), /timeout/);
});
