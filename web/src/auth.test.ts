import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, authHeaders, loadOwnerToken, saveOwnerToken } from './auth';

describe('owner token storage', () => {
  it('persists and clears the owner token', () => {
    saveOwnerToken('signed-token');
    expect(loadOwnerToken()).toBe('signed-token');

    saveOwnerToken('');
    expect(loadOwnerToken()).toBe('');
  });
});

describe('authHeaders', () => {
  it('uses the correct credential for each account type', () => {
    expect(authHeaders(null)).toEqual({});
    expect(authHeaders({ kind: 'user', token: 'owner-token' })).toEqual({ Authorization: 'Bearer owner-token' });
    expect(authHeaders({ kind: 'admin', key: 'admin-key' })).toEqual({ 'X-Admin-Key': 'admin-key' });
  });
});

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serializes a request body and returns envelope data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { token: 'abc' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('https://api.example', '/login', {}, { body: { email: 'owner@example.com' } })).resolves.toEqual({ token: 'abc' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
  });

  it('surfaces API errors with their HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Code expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(api('https://api.example', '/login', {})).rejects.toEqual(new ApiError('Code expired', 401));
  });
});
