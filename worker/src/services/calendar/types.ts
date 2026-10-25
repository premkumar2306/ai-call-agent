import type { Env } from '../../types';

// Contract every calendar provider (Google today; Microsoft, Cal.com, … next)
// implements. Providers are thin REST adapters: no D1, no KV, no business
// logic. Connection storage, token caching, retries and the booking rules
// live once in ./index.ts, so adding a provider is one new file plus an
// entry in PROVIDERS there.

export interface BusyInterval { start: number; end: number } // epoch ms, end exclusive

export interface CalendarInfo { id: string; name: string; primary: boolean }

export interface CalendarEvent {
  title: string;
  description: string;
  start: Date;
  end: Date;
  /** Business-local wall clock ("YYYY-MM-DDTHH:MM:SS") when known — lets the provider show the booking in the business's zone. */
  localStart?: string;
  localEnd?: string;
  timeZone: string;
  /** Mogi order ID, stored on the event so it can be traced back. */
  externalId: string;
}

export interface OAuthTokens {
  refreshToken: string;
  accessToken: string;
  expiresIn: number; // seconds
  accountEmail: string | null;
}

export class CalendarError extends Error {
  /** `reauth`: the stored grant is dead (revoked/expired) — only reconnecting fixes it. */
  constructor(message: string, readonly status?: number, readonly reauth = false) { super(message); }
}

export interface CalendarProvider {
  /** Stored in calendar_connections.provider and used in URLs. */
  id: string;
  displayName: string;
  /** Whether this deployment has the provider's app credentials. */
  configured(env: Env): boolean;

  // OAuth (authorization-code flow with offline access)
  authUrl(env: Env, redirectUri: string, state: string): string;
  exchangeCode(env: Env, code: string, redirectUri: string): Promise<OAuthTokens>;
  refreshAccessToken(env: Env, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
  revoke(env: Env, refreshToken: string): Promise<void>;

  // Calendar API. Throw CalendarError with status 401 for an expired access
  // token; the caller refreshes once and retries.
  listCalendars(accessToken: string): Promise<CalendarInfo[]>;
  freeBusy(accessToken: string, calendarId: string, timeMin: Date, timeMax: Date, timeoutMs: number): Promise<BusyInterval[]>;
  /** Returns the provider's event ID. */
  createEvent(accessToken: string, calendarId: string, event: CalendarEvent, timeoutMs: number): Promise<string>;
  /** Must succeed (not throw) when the event is already gone. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string, timeoutMs: number): Promise<void>;
}
