import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./pages/Home', () => ({ default: () => <div>Home content</div> }));
vi.mock('./pages/Business', () => ({ default: () => <div>Business settings</div> }));
vi.mock('./pages/Settings', () => ({
  default: () => <div>Line settings</div>,
  LocaleSettings: () => <div>Locale settings</div>,
}));

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function signedInFetch(role: 'owner' | 'staff') {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/account/me')) {
      return Promise.resolve(jsonResponse({
        user: { id: 'user-1', email: `${role}@example.com`, name: role },
        businesses: [{ key: 'studio', name: 'Studio', kind: null, role }],
      }));
    }
    if (url.includes('/admin/sectors/studio')) {
      return Promise.resolve(jsonResponse({ kind: null, vertical: null, currency: 'USD', locale: 'en-US', countryCode: 'US' }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe('role-based navigation', () => {
  beforeEach(() => {
    sessionStorage.setItem('avery.ownerToken', 'signed-token');
  });

  it('lets an owner navigate to settings', async () => {
    vi.stubGlobal('fetch', signedInFetch('owner'));
    render(<App />);

    const menu = await screen.findByRole('navigation', { name: 'Main' });
    fireEvent.click(await within(menu).findByRole('button', { name: 'Settings' }));

    expect(window.location.hash).toBe('#/settings');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Business settings')).toBeInTheDocument();
  });

  it('does not expose owner-only settings to staff', async () => {
    vi.stubGlobal('fetch', signedInFetch('staff'));
    render(<App />);

    await screen.findByText((_, element) => element?.classList.contains('who') === true && element.textContent?.includes('· Staff') === true);
    const menu = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(menu).queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
