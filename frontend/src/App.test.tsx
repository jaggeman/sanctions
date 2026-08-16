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

/** Simulates every CSS media query matching (or not) — i.e. a narrow/mobile viewport. */
function stubViewportMatches(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

describe('App component navigation tabs', () => {
  it('renders the Search tab by default', async () => {
    await renderLoggedIn();
    expect(screen.getByText('Search Entities')).toBeInTheDocument();
  });

  it('renders the main tab bar as scrollable so 7 tabs never clip on a narrow viewport', async () => {
    await renderLoggedIn();
    const tablist = screen.getByRole('tablist', { name: 'app tabs' });
    // MUI only renders the MuiTabs-scroller wrapper with this class when variant="scrollable".
    expect(tablist.closest('.MuiTabs-root')?.querySelector('.MuiTabs-scrollableX')).not.toBeNull();
  });

  it('hides the signed-in email in the header on a narrow (mobile) viewport', async () => {
    const restore = stubViewportMatches(true);
    try {
      await renderLoggedIn();
      expect(screen.queryByText('analyst@example.com')).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('shows the signed-in email in the header on a wide (desktop) viewport', async () => {
    const restore = stubViewportMatches(false);
    try {
      await renderLoggedIn();
      expect(screen.getByText('analyst@example.com')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('navigates to Official Sources tab', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Official Sources'));

    await waitFor(() => {
      expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
      expect(screen.getByText('UN Security Council Consolidated List')).toBeInTheDocument();
      expect(screen.getByText('OFAC Sanctions List Search')).toBeInTheDocument();
      expect(screen.getByText('The UK Sanctions List (FCDO)')).toBeInTheDocument();
      expect(screen.getByText('SECO SESAM Sanctions Database')).toBeInTheDocument();
    });
  });

  it('navigates to Help & Manual tab', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Help & Manual'));

    await waitFor(() => {
      expect(screen.getByText('User Manual & Help')).toBeInTheDocument();
      expect(screen.getByText('How to Search')).toBeInTheDocument();
      expect(screen.getByText('Uploading Lists')).toBeInTheDocument();
      expect(screen.getByText('Managing API Tokens')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Official Sources' })).toBeInTheDocument();
    });
  });

  it('documents fuzzy match scoring and all upload sources in the manual', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Help & Manual'));

    await waitFor(() => {
      expect(screen.getByText(/match score/i)).toBeInTheDocument();
      expect(screen.getByText(/non-Latin/i)).toBeInTheDocument();
      expect(screen.getAllByText(/duplicate/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Import History/i).length).toBeGreaterThan(0);
    });
  });

  it('stays on the login screen when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null }) as Response));
    render(<App />);

    await waitFor(() => expect(screen.queryByText('Search Entities')).not.toBeInTheDocument());
  });

  it('navigates to the Import History tab (issue #12)', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Import History'));

    await waitFor(() => expect(screen.getByText(/no imports yet/i)).toBeInTheDocument());
  });

  it('issue #165: does not reopen the import-detail dialog on a later visit to Import History', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
        }
        if (url.includes('/api/upload')) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'Identical file already imported as import #abc123.',
              duplicateOfImportId: 'abc123',
            }),
          } as Response;
        }
        if (url.includes('/api/imports')) {
          return {
            ok: true,
            json: async () => [
              {
                importId: 'abc123',
                filename: 'eu_list.xml',
                source: 'EU',
                format: 'eu-xml-1.1',
                uploadedAt: '2026-08-15T10:00:00.000Z',
                uploadedBy: 'analyst@example.com',
                status: 'applied',
                counts: { parsed: 100, uploaded: 100 },
              },
            ],
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await renderLoggedIn();

    // 1. Upload a duplicate file, follow "View import".
    fireEvent.click(screen.getByText('Upload Lists'));
    await waitFor(() => expect(document.querySelector('input[type="file"]')).toBeInTheDocument());
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'eu_list.xml', { type: 'text/xml' })] } });

    await waitFor(() => expect(screen.getByText(/already imported/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /view import/i }));

    // 2. Import History opens with the detail dialog already showing.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // 3. Close it.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // 4. Leave the tab and come back.
    fireEvent.click(screen.getByRole('tab', { name: /^search$/i }));
    fireEvent.click(screen.getByText('Import History'));

    // 5. The list loads again, but the dialog must not reopen on its own.
    await waitFor(() => expect(screen.getAllByText('eu_list.xml').length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the record detail view when a search result is clicked (issue #12)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
        }
        if (url.includes('/api/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 'EU-1', source: 'EU', type: 'individual', names: [{ wholeName: 'Test Person', strong: true }] }],
              totalMatches: 1,
              truncated: false,
            }),
          } as Response;
        }
        if (url.includes('/versions')) {
          return { ok: true, json: async () => [] } as Response;
        }
        if (url.includes('/api/sanctions/')) {
          return { ok: true, json: async () => ({ id: 'EU-1', source: 'EU', type: 'individual', names: [{ wholeName: 'Test Person', strong: true }] }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await renderLoggedIn();
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Test Person' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getAllByText('Test Person').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Test Person')[0]);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('issue #188: preserves search query and results when switching tabs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, json: async () => ({ email: 'analyst@example.com' }) } as Response;
        }
        if (url.includes('/api/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 'TEST-1', source: 'TEST', type: 'individual', names: [{ wholeName: 'Vladimir Putin', strong: true }] }],
              totalMatches: 1,
              truncated: false,
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await renderLoggedIn();
    
    // 1. Search
    const searchInput = screen.getByPlaceholderText(/search by name/i);
    fireEvent.change(searchInput, { target: { value: 'Vladimir Putin' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    
    await waitFor(() => expect(screen.getByText('Vladimir Putin')).toBeInTheDocument());
    
    // 2. Switch tab
    fireEvent.click(screen.getByText('Official Sources'));
    await waitFor(() => expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument());
    
    // 3. Switch back
    fireEvent.click(screen.getByRole('tab', { name: /^search$/i }));
    
    // 4. Verify state is preserved
    expect(screen.getByPlaceholderText(/search by name/i)).toHaveValue('Vladimir Putin');
    expect(screen.getByText('Vladimir Putin')).toBeInTheDocument();
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

    await waitFor(() => expect(document.querySelector('input[type="file"]')).toBeInTheDocument());
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
