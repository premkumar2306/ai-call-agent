import { describe, expect, it } from 'vitest';
import { INDIA_DENTAL as P, businessKey, pilotWindow, serviceId } from '../src/services/presets';
import { BUSINESS_KINDS, isValidHoursRange, isValidTimezone, parseBusinessPatch, parseServices, storedVertical } from '../src/services/accounts';
import { DEFAULT_VOICE, parseVoiceInput } from '../src/services/voice-language';
import { validateClinicFeatures } from '../src/services/clinic-features';
import { validatePilotInput } from '../src/services/pilot';
import { validatePracticeInput } from '../src/services/practice';
import { parsePrivacySettings } from '../src/routes/privacy';
import { isValidCountryCode, isValidLocale, isValidCurrency } from '../src/utils/locale';

describe('India dental preset', () => {
  it('sets exactly the agreed defaults', () => {
    expect({ c: P.countryCode, cur: P.currency, tz: P.timezone, loc: P.locale, kind: P.kind, voice: P.voice }).toEqual({
      c: 'IN', cur: 'INR', tz: 'Asia/Kolkata', loc: 'en-IN', kind: 'dental',
      voice: { voice_language: 'hi-en', stt_provider: 'sarvam', tts_provider: 'sarvam', speaking_rate: 'slow', interruption_sensitivity: 'low', endpointing: 'patient', noise_cancellation: true },
    });
    expect([P.durationBooking, P.guardrails, P.dtmfInput, P.confirmationMode]).toEqual([true, true, true, true]);
    expect([P.plan, P.offer, P.pilot]).toEqual(['in_clinic', 'FOUNDING25', { mode: 'overflow', days: 14 }]);
    expect(P.dpdp).toEqual({ aiDisclosure: true, disclosureText: null });
  });

  it('keeps every message to patients OFF', () => {
    expect(Object.values(P.whatsapp).every(v => v === false)).toBe(true);
    expect(Object.keys(P.whatsapp).sort()).toEqual(['missedCallFollowup', 'noShowRecovery', 'recalls', 'reminders', 'reviewRequests']);
  });

  it('passes the same validators the admin APIs use', () => {
    expect(isValidCountryCode(P.countryCode) && isValidCurrency(P.currency) && isValidLocale(P.locale) && isValidTimezone(P.timezone)).toBe(true);
    expect(P.kind in BUSINESS_KINDS).toBe(true);
    expect(storedVertical(P.kind)).toBe('clinic');
    expect(typeof parseBusinessPatch({ kind: P.kind, timezone: P.timezone, currency: P.currency, country_code: P.countryCode, locale: P.locale, hours: P.hours })).toBe('object');
    expect(Object.values(P.hours).every(isValidHoursRange)).toBe(true);
    expect(parseVoiceInput(P.voice, DEFAULT_VOICE, true)).toMatchObject({ ok: true });
    expect(typeof validateClinicFeatures({ durationBooking: P.durationBooking, ...P.whatsapp })).toBe('object');
    expect(typeof parsePrivacySettings(P.dpdp)).toBe('object');
    expect(parsePrivacySettings(P.dpdp)).not.toHaveProperty('error');
    expect(typeof validatePilotInput({ enabled: true, ...pilotWindow('2026-12-01', P.pilot.days) })).toBe('object');
    expect(typeof validatePracticeInput({ confirmationMode: true, frontDeskPhone: '+91 98450 12345' })).toBe('object');
  });

  it('has the dental starter services with durations and a consultation first', () => {
    const list = parseServices(P.services.map(s => ({ ...s, priceCents: 0, description: '' })));
    expect(Array.isArray(list)).toBe(true);
    expect(P.services).toHaveLength(8);
    expect(P.services[0]).toMatchObject({ name: 'Consultation', category: 'CONSULTATION' });
    expect(P.services.find(s => s.name === 'Root canal')?.durationMinutes).toBe(60);
  });

  it('makes stable keys and ids, so re-running never duplicates', () => {
    expect(businessKey('lotus-dental-hub-bengaluru')).toBe('lotus_dental_hub_bengaluru');
    expect(businessKey('dr-gowd-s-dental-hospitals-hyderabad')).toBe('dr_gowd_s_dental_hospitals_hyderabad');
    expect(serviceId('k', 'Cleaning / scaling')).toBe('k-svc-cleaning-scaling');
  });

  it('pilot window is 14 days from the activation date', () => {
    expect(pilotWindow('2026-11-18', 14)).toEqual({ startsOn: '2026-11-18', endsOn: '2026-12-02' });
    expect(pilotWindow('2026-12-25', 14)).toEqual({ startsOn: '2026-12-25', endsOn: '2027-01-08' });
  });
});
