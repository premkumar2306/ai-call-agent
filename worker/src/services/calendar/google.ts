import type { Env } from '../../types';
import { CalendarError, type CalendarProvider, type BusyInterval } from './types';

// Google Calendar adapter — plain fetch against the REST API (the googleapis
// SDK isn't Workers-friendly). Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// from a Google Cloud OAuth client (Web application) whose authorized
// redirect URI is <worker origin>/oauth/google/callback.

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',   // create / delete booking events
  'https://www.googleapis.com/auth/calendar.readonly', // calendar list + free/busy
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_TIMEOUT_MS = 8000;

async function tokenRequest(env: Env, body: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...body }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CalendarError(`Google token error: ${json.error ?? res.status}`, res.status, json.error === 'invalid_grant');
  }
  return json;
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    // Straight from Google's token endpoint over TLS, so no signature check needed.
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).email ?? null;
  } catch {
    return null;
  }
}

async function api(accessToken: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) return res;
  const json: any = await res.json().catch(() => ({}));
  throw new CalendarError(`Google Calendar ${res.status}: ${json?.error?.message ?? res.statusText}`, res.status);
}

export const googleCalendar: CalendarProvider = {
  id: 'google',
  displayName: 'Google Calendar',

  configured: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),

  authUrl(env, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Forces a refresh token even if this Google account connected before.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchangeCode(env, code, redirectUri) {
    const tok = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!tok.refresh_token) {
      throw new CalendarError('Google did not return a refresh token — remove Mogi from the Google account’s third-party access and connect again');
    }
    // Google lets the user untick individual scopes on the consent screen.
    const granted = String(tok.scope ?? '').split(' ');
    if (SCOPES.some(s => s.startsWith('https://') && !granted.includes(s))) {
      throw new CalendarError('Calendar access was not granted — tick both calendar permissions on the Google consent screen');
    }
    return {
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      expiresIn: tok.expires_in ?? 3600,
      accountEmail: emailFromIdToken(tok.id_token),
    };
  },

  async refreshAccessToken(env, refreshToken) {
    const tok = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: tok.access_token, expiresIn: tok.expires_in ?? 3600 };
  },

  async revoke(_env, refreshToken) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  },

  async listCalendars(accessToken) {
    const res = await api(accessToken, '/users/me/calendarList?minAccessRole=writer', { method: 'GET' }, TOKEN_TIMEOUT_MS);
    const json: any = await res.json();
    return (json.items ?? []).map((c: any) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: !!c.primary }));
  },

  async freeBusy(accessToken, calendarId, timeMin, timeMax, timeoutMs) {
    const res = await api(accessToken, '/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: calendarId }] }),
    }, timeoutMs);
    const json: any = await res.json();
    const cal = json.calendars?.[calendarId];
    if (!cal || cal.errors?.length) throw new CalendarError(`Google free/busy error: ${cal?.errors?.[0]?.reason ?? 'calendar not returned'}`);
    return (cal.busy ?? []).map((b: any): BusyInterval => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  },

  async createEvent(accessToken, calendarId, event, timeoutMs) {
    const when = event.localStart && event.localEnd
      ? { start: { dateTime: event.localStart, timeZone: event.timeZone }, end: { dateTime: event.localEnd, timeZone: event.timeZone } }
      : { start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } };
    const res = await api(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        summary: event.title,
        description: event.description,
        ...when,
        extendedProperties: { private: { mogiOrderId: event.externalId } },
      }),
    }, timeoutMs);
    return (await res.json() as any).id;
  },

  async deleteEvent(accessToken, calendarId, eventId, timeoutMs) {
    try {
      await api(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }, timeoutMs);
    } catch (e) {
      // 404/410: already deleted by someone in Google Calendar — that's fine.
      if (e instanceof CalendarError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  },
};
