import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Login from './Login';

describe('Login', () => {
  it('completes the email-code sign-in flow', async () => {
    const me = {
      user: { id: 'user-1', email: 'owner@example.com', name: 'Owner' },
      businesses: [{ key: 'studio', name: 'Studio', kind: null, role: 'owner' as const }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { devCode: '123456' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...me, token: 'signed-token' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onSignedIn = vi.fn();

    render(<Login base="https://api.example" onSignedIn={onSignedIn} onAdminKey={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByText(/your code is 123456/i)).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('signed-token', me));
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.example/account/login/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.example/account/login/verify', expect.objectContaining({
      body: JSON.stringify({ email: 'owner@example.com', code: '123456' }),
    }));
  });

  it('supports operator sign-in without calling the API', () => {
    const onAdminKey = vi.fn();
    render(<Login base="https://api.example" onSignedIn={vi.fn()} onAdminKey={onAdminKey} />);

    fireEvent.click(screen.getByRole('button', { name: /operator.*admin key/i }));
    fireEvent.change(screen.getByPlaceholderText('X-Admin-Key'), { target: { value: 'operator-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onAdminKey).toHaveBeenCalledWith('operator-secret');
  });
});
