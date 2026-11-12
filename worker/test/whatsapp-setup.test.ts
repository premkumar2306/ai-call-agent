import { describe, expect, it } from 'vitest';
import {
  choosePhoneNumber, describePhoneNumbers, explainGraphError, GRAPH_VERSION, mask, mergeConfig, needsRegistration,
  normalizeRecipient, parseArgs, parseDotEnv, planMapping, redact, webhookUrl,
} from '../scripts/whatsapp-setup-lib.mjs';
import { GRAPH_API_VERSION } from '../src/services/whatsapp-api';

describe('whatsapp-setup script helpers', () => {
  it('uses the same Graph API version as the Worker', () => {
    expect(GRAPH_VERSION).toBe(GRAPH_API_VERSION);
  });

  it('parses flags', () => {
    expect(parseArgs(['--dry-run', '--map', 'my_clinic', '--test-to=+91 98450 12345'])).toMatchObject({ dryRun: true, map: 'my_clinic', testTo: '+91 98450 12345' });
    expect(() => parseArgs(['--map'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('reads .env files; the environment wins', () => {
    const env = parseDotEnv('# c\nexport WA_ACCESS_TOKEN="EAAabc"\nWA_WABA_ID=123 # id\nWORKER_URL=\'https://w.example\'\nbad line\n');
    expect(env).toEqual({ WA_ACCESS_TOKEN: 'EAAabc', WA_WABA_ID: '123', WORKER_URL: 'https://w.example' });
    const cfg = mergeConfig(env, { WA_WABA_ID: '999', ADMIN_SECRET: 'adm' });
    expect(cfg).toMatchObject({ accessToken: 'EAAabc', wabaId: '999', workerUrl: 'https://w.example', adminKey: 'adm' });
  });

  it('never shows secrets', () => {
    expect(mask('EAAB1234567890')).toBe('EA…90 (14 chars)');
    expect(mask('short')).toBe('•••••');
    expect(mask(undefined)).toBe('(not set)');
    expect(redact('token EAAB12345678901234567890xyz and verify my-verify-token', 'my-verify-token')).toBe('token [redacted] and verify [redacted]');
  });

  it('builds the webhook URL', () => {
    expect(webhookUrl('ai-call-agent.me.workers.dev/')).toBe('https://ai-call-agent.me.workers.dev/whatsapp/webhook');
    expect(webhookUrl('https://api.example.in')).toBe('https://api.example.in/whatsapp/webhook');
    expect(() => webhookUrl('http://api.example.in')).toThrow(/https/);
    expect(() => webhookUrl(undefined)).toThrow(/WORKER_URL/);
  });

  it('normalises the test recipient', () => {
    expect(normalizeRecipient('+91 98450-12345')).toBe('919845012345');
    expect(() => normalizeRecipient('98450')).toThrow(/country code/);
  });

  it('describes numbers and warns in plain words', () => {
    const { rows, warnings } = describePhoneNumbers([
      { id: '1', display_phone_number: '+91 80 4710 0000', verified_name: 'Smile Dental', quality_rating: 'GREEN', status: 'CONNECTED', name_status: 'APPROVED' },
      { id: '2', display_phone_number: '+91 80 4710 0001', verified_name: 'Smile 2', quality_rating: 'RED', status: 'PENDING', name_status: 'DECLINED' },
    ]);
    expect(rows[0]).toEqual({ phone_number_id: '1', number: '+91 80 4710 0000', verified_name: 'Smile Dental', quality: 'GREEN', status: 'CONNECTED', name_status: 'APPROVED' });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/PENDING.*register-pin/);
    expect(needsRegistration({ status: 'CONNECTED' })).toBe(false);
    expect(needsRegistration({ status: 'PENDING' })).toBe(true);
    expect(choosePhoneNumber(rows, '2')!.phone_number_id).toBe('2');
    expect(choosePhoneNumber(rows)).toBeNull();
    expect(choosePhoneNumber(rows.slice(0, 1))!.phone_number_id).toBe('1');
    expect(() => choosePhoneNumber(rows, '3')).toThrow(/not in this WhatsApp Business Account/);
  });

  it('plans the mapping idempotently', () => {
    const existing = [{ phoneNumberId: '1', businessType: 'a' }];
    expect(planMapping(existing, '1', 'a')).toBe('same');
    expect(planMapping(existing, '1', 'b')).toBe('update');
    expect(planMapping(existing, '2', 'a')).toBe('create');
  });

  it('explains common Graph errors', () => {
    expect(explainGraphError(401, { error: { code: 190, message: 'Session expired' } })).toMatch(/HTTP 401, code 190: Session expired\n.*System User token/);
    expect(explainGraphError(400, { error: { code: 131030, message: 'Recipient not allowed' } })).toMatch(/allowed list/);
    expect(explainGraphError(500, {})).toBe('HTTP 500: request failed');
  });
});
