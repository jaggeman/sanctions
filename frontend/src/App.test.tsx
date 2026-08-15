import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App';

/**
 * App renders <Login /> until GET /api/auth/session resolves to an email
 * (added by the OTP login gate). These tests are about tab navigation, so
 * stub the session check as already-authenticated and get past the gate.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/session')) {
        return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderLoggedIn() {
  render(<App />);
  // Wait for the session check to resolve and the real UI to replace <Login />.
  await waitFor(() => expect(screen.getByText('Search Entities')).toBeInTheDocument());
}

describe('App component navigation tabs', () => {
  it('renders the Search tab by default', async () => {
    await renderLoggedIn();
    expect(screen.getByText('Search Entities')).toBeInTheDocument();
  });

  it('navigates to Official EU Lists tab', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Official EU Lists'));

    expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
    expect(screen.getByText('Consolidated Financial Sanctions')).toBeInTheDocument();
  });

  it('navigates to Help & Manual tab', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Help & Manual'));

    expect(screen.getByText('User Manual & Help')).toBeInTheDocument();
    expect(screen.getByText('How to Search')).toBeInTheDocument();
    expect(screen.getByText('Uploading Lists')).toBeInTheDocument();
    expect(screen.getByText('Official Sources')).toBeInTheDocument();
  });

  it('stays on the login screen when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null }) as Response));
    render(<App />);

    await waitFor(() => expect(screen.queryByText('Search Entities')).not.toBeInTheDocument());
  });
});

describe('App — session-expiry handling (issue #59)', () => {
  it('a 401 from /api/search returns to Login instead of showing "No results found"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
        }
        if (url.includes('/api/search')) {
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await renderLoggedIn();

    fireEvent.change(screen.getByPlaceholderText('Search by name, passport, or ID...'), {
      target: { value: 'Vladimir Putin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Returned to Login — the actual acceptance criterion, not just a message
    // string. This marker text is unique to Login, unlike "Search Entities"
    // which is also absent whenever any other tab happens to be selected.
    await waitFor(() =>
      expect(screen.getByText('Sign in with a one-time code sent to your email.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('No results found. Enter a query to begin your search.')).not.toBeInTheDocument();
  });

  it('a 401 from /api/upload does not show the generic "Upload failed." message', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
        }
        if (url.includes('/api/upload')) {
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await renderLoggedIn();
    fireEvent.click(screen.getByText('Upload Lists'));

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'list.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Returned to Login — the real acceptance criterion. A 401's own error
    // message ("Authentication required") happening to differ from the
    // literal string "Upload failed." is not enough on its own: the app must
    // actually route back to Login, not just show a different toast while
    // silently staying on a dead session.
    await waitFor(() =>
      expect(screen.getByText('Sign in with a one-time code sent to your email.')).toBeInTheDocument(),
    );
    expect(alertSpy).not.toHaveBeenCalledWith('Upload failed.');

    alertSpy.mockRestore();
  });

  it('registers setOnSessionExpired exactly once per mount and cleans up on unmount', async () => {
    const apiFetchModule = await import('./apiFetch');
    const setSpy = vi.spyOn(apiFetchModule, 'setOnSessionExpired');

    const { unmount, rerender } = render(<App />);
    await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));

    // A re-render (not a remount) must not register a second listener.
    rerender(<App />);
    expect(setSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(setSpy).toHaveBeenLastCalledWith(null);

    setSpy.mockRestore();
  });
});
