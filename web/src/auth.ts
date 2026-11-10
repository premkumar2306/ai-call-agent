// Who the dashboard is acting as, and the headers that prove it.
//
// - Business owners and staff sign in with an emailed code. The Worker hands
//   back a signed token that is kept in localStorage (it's sent as a Bearer
//   header; a cookie would be third-party here, since the UI and the Worker
//   live on different sites). Logging out revokes it server-side.
// - The operator can still use ADMIN_SECRET (adminKey.ts, sessionStorage).

const TOKEN_KEY = 'avery.ownerToken';

export type Auth =
  | { kind: 'admin'; key: string }
  | { kind: 'user'; token: string }
  | null;

export function loadOwnerToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function saveOwnerToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable — token lives in memory only */ }
}

export function authHeaders(auth: Auth): Record<string, string> {
  if (!auth) return {};
  return auth.kind === 'admin' ? { 'X-Admin-Key': auth.key } : { Authorization: `Bearer ${auth.token}` };
}

export interface Business { key: string; name: string; kind: string | null; role: 'owner' | 'staff' }
export interface Me { user: { id: string; email: string; name: string | null }; businesses: Business[] }

/** fetch + JSON with the API's { success, data, error } envelope. */
export async function api<T = any>(base: string, path: string, auth: Record<string, string>, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { ...auth, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status);
  return json.data as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
