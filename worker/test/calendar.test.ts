import { describe, expect, it } from 'vitest';
import { toInstant, addMinutesLocal } from '../src/utils/time';
import { encryptSecret, decryptSecret } from '../src/utils/calendar-crypto';
import {
  overlapsBusy, bookingInterval, parseEventRef, signOAuthState, verifyOAuthState, listProviders,
} from '../src/services/calendar';
import type { Env } from '../src/types';

const env = (over: Partial<Env> = {}) =>
  ({ TOKEN_SECRET: 'x'.repeat(32), NODE_ENV: 'production', ...over }) as Env;

describe('toInstant', () => {
  it('converts business-local wall clock to UTC, across DST', () => {
    // Chicago is UTC-5 in summer (CDT), UTC-6 in winter (CST).
    expect(toInstant('2026-07-01T09:00:00', 'America/Chicago').toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(toInstant('2026-12-01T09:00', 'America/Chicago').toISOString()).toBe('2026-12-01T15:00:00.000Z');
    expect(toInstant('2026-04-15T09:00:00', 'Asia/Kolkata').toISOString()).toBe('2026-04-15T03:30:00.000Z');
  });
  it('keeps strings that already carry an offset', () => {
    expect(toInstant('2026-04-15T09:00:00Z', 'America/Chicago').toISOString()).toBe('2026-04-15T09:00:00.000Z');
    expect(toInstant('2026-04-15T09:00:00+02:00', 'America/Chicago').toISOString()).toBe('2026-04-15T07:00:00.000Z');
  });
  it('falls back to UTC for an unknown zone', () => {
    expect(toInstant('2026-04-15T09:00:00', 'Not/AZone').toISOString()).toBe('2026-04-15T09:00:00.000Z');
  });
});

describe('addMinutesLocal', () => {
  it('adds on the wall clock, rolling over days', () => {
    expect(addMinutesLocal('2026-04-15T09:00:00', 90)).toBe('2026-04-15T10:30:00');
    expect(addMinutesLocal('2026-04-15T23:30', 60)).toBe('2026-04-16T00:30:00');
  });
});

describe('busy overlap', () => {
  const busy = [{ start: Date.parse('2026-07-01T15:00:00Z'), end: Date.parse('2026-07-01T16:00:00Z') }];
  it('blocks any slot whose full length overlaps a busy block', () => {
    // 9:00–10:30 Chicago = 14:00–15:30Z → overlaps 15:00–16:00Z.
    const { start, end } = bookingInterval('2026-07-01T09:00:00', 90, 'America/Chicago');
    expect(overlapsBusy(start.getTime(), end.getTime(), busy)).toBe(true);
  });
  it('allows back-to-back slots', () => {
    const { start, end } = bookingInterval('2026-07-01T09:00:00', 60, 'America/Chicago'); // 14:00–15:00Z
    expect(overlapsBusy(start.getTime(), end.getTime(), busy)).toBe(false);
  });
});

describe('parseEventRef', () => {
  it('splits provider, calendar and event, allowing @ in calendar IDs', () => {
    expect(parseEventRef('google|shop@group.calendar.google.com|abc123'))
      .toEqual({ provider: 'google', calendarId: 'shop@group.calendar.google.com', eventId: 'abc123' });
    expect(parseEventRef('garbage')).toBeNull();
  });
});

describe('refresh-token encryption', () => {
  it('round-trips and rejects the wrong key', async () => {
    const enc = await encryptSecret('1//refresh-token', 'key-a');
    expect(enc).not.toContain('refresh-token');
    expect(await decryptSecret(enc, 'key-a')).toBe('1//refresh-token');
    await expect(decryptSecret(enc, 'key-b')).rejects.toThrow();
  });
});

describe('OAuth state', () => {
  const s = { businessType: 'dental', provider: 'google', returnTo: 'https://mogi-admin.pages.dev/' };
  it('round-trips', async () => {
    expect(await verifyOAuthState(env(), await signOAuthState(env(), s))).toEqual(s);
  });
  it('rejects state signed with another secret', async () => {
    const tok = await signOAuthState(env({ TOKEN_SECRET: 'y'.repeat(32) }), s);
    expect(await verifyOAuthState(env(), tok)).toBeNull();
  });
});

describe('listProviders', () => {
  it('needs both the encryption key and the provider credentials', () => {
    expect(listProviders(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }))[0].configured).toBe(false);
    expect(listProviders(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', CALENDAR_TOKEN_KEY: 'k' }))[0])
      .toEqual({ id: 'google', name: 'Google Calendar', configured: true });
  });
});
