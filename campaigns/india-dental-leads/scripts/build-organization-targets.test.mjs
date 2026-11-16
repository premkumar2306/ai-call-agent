import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrganizationPayloads,
  organizationIdentity
} from './build-organization-targets.mjs';

function location(overrides = {}) {
  return {
    id: 'location-1',
    overtureId: 'overture-1',
    clinicName: 'Example Dental',
    locality: 'Central',
    address: '1 Main Road',
    postcode: '560001',
    latitude: 12.9,
    longitude: 77.6,
    publicPhones: ['+919999999999'],
    publicWebsites: ['https://exampledental.com'],
    publicEmails: ['info@exampledental.com'],
    emailDomainValidations: [{ email: 'info@exampledental.com', status: 'mx_valid' }],
    sourceConfidence: 0.95,
    qualityScore: 95,
    ...overrides
  };
}

test('groups branches by first-party domain and ranks the organization first', () => {
  const payloads = buildOrganizationPayloads({
    bengaluru: { targets: [
      location({ id: 'one', overtureId: 'one', clinicName: 'Bright Dental Indiranagar' }),
      location({ id: 'two', overtureId: 'two', clinicName: 'Bright Dental Whitefield' })
    ] },
    chennai: { targets: [location({
      id: 'three',
      overtureId: 'three',
      clinicName: 'Solo Dental',
      publicWebsites: ['https://solo.example'],
      publicEmails: []
    })] },
    hyderabad: { targets: [] }
  }, '2026-11-14T00:00:00Z');

  const [organization] = payloads.bengaluru.organizations;
  assert.equal(organization.locationCountInCity, 2);
  assert.equal(organization.segment, 'growing_group');
  assert.equal(organization.organizationTier, 'B');
  assert.deepEqual(organization.publicEmails, ['info@exampledental.com']);
});

test('does not merge unrelated clinics using an ignored platform domain', () => {
  const first = organizationIdentity(location({
    overtureId: 'one',
    clinicName: 'Alpha Dental',
    publicWebsites: ['https://alpha.localo.site'],
    publicEmails: []
  }));
  const second = organizationIdentity(location({
    overtureId: 'two',
    clinicName: 'Beta Dental',
    publicWebsites: ['https://beta.localo.site'],
    publicEmails: []
  }));

  assert.notEqual(first.key, second.key);
});

test('merges known chains across city-specific names', () => {
  const first = organizationIdentity(location({ clinicName: 'Clove Dental HSR', publicWebsites: [] }));
  const second = organizationIdentity(location({ clinicName: 'Clove Dental Chennai', publicWebsites: [] }));

  assert.equal(first.key, 'chain:clove-dental');
  assert.equal(first.key, second.key);
  assert.equal(first.name, 'Clove Dental');
});

test('keeps generic clinic names as separate locations without a branded domain', () => {
  const first = organizationIdentity(location({
    overtureId: 'one',
    clinicName: 'Smile Dental Clinic',
    publicWebsites: [],
    publicEmails: ['smileone@gmail.com']
  }));
  const second = organizationIdentity(location({
    overtureId: 'two',
    clinicName: 'Smile Dental Clinic',
    publicWebsites: [],
    publicEmails: ['smiletwo@gmail.com']
  }));

  assert.notEqual(first.key, second.key);
});
