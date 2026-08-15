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
    expect(screen.getByText('Managing API Tokens')).toBeInTheDocument();
    expect(screen.getByText('Official Sources')).toBeInTheDocument();
  });

  it('documents fuzzy match scoring and all upload sources in the manual', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByText('Help & Manual'));

    expect(screen.getByText(/match score/i)).toBeInTheDocument();
    expect(screen.getByText(/non-Latin/i)).toBeInTheDocument();
    expect(screen.getByText(/PEP.*CUSTOM|CUSTOM.*PEP/)).toBeInTheDocument();
  });

  it('stays on the login screen when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null }) as Response));
    render(<App />);

    await waitFor(() => expect(screen.queryByText('Search Entities')).not.toBeInTheDocument());
  });
});
