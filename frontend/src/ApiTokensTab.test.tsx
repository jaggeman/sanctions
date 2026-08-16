import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import ApiTokensTab from './ApiTokensTab';
import { setOnSessionExpired } from './apiFetch';

/**
 * ApiTokensTab checks GET /api/auth/session on mount and gates its content
 * on the isAdmin field (issue #17's "the frontend tab is hidden/blocked for
 * non-admins" acceptance criterion — requireAdmin alone only protects the
 * backend routes, not what renders client-side).
 */
function stubFetch(sessionResponse: { ok: boolean; body?: any }, tokens: any[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/session')) {
        return { ok: sessionResponse.ok, json: async () => sessionResponse.body } as Response;
      }
      if (url.includes('/api/admin/tokens')) {
        return { ok: true, json: async () => tokens } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiTokensTab — session expiry (issue #38)', () => {
  it('shows a session-expired message, not the generic error, when the tokens list 401s mid-session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText(/session.*expired|sign in again/i)).toBeInTheDocument());
  });

  it('fires the shared onSessionExpired callback when the tokens list 401s', async () => {
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<ApiTokensTab />);

    await waitFor(() => expect(onExpired).toHaveBeenCalled());
    setOnSessionExpired(null);
  });
});

describe('ApiTokensTab access gating', () => {
  it('shows an admins-only message and no token UI when isAdmin is false', async () => {
    stubFetch({ ok: true, body: { email: 'user@example.com', isAdmin: false } });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText(/restricted to admins/i)).toBeInTheDocument());
    expect(screen.queryByText('Create API Token')).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect to AI Clients/i)).not.toBeInTheDocument();
  });

  it('shows the token management UI and MCP guide when isAdmin is true', async () => {
    stubFetch({ ok: true, body: { email: 'admin@example.com', isAdmin: true } });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());
    expect(screen.queryByText(/restricted to admins/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Connect to AI Clients/i)).toBeInTheDocument();
  });

  it('treats a failed session check (e.g. 401) as denied rather than throwing', async () => {
    stubFetch({ ok: false });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText(/restricted to admins/i)).toBeInTheDocument());
  });
});

describe('ApiTokensTab token creation error handling (issue #166)', () => {
  it('falls back to a friendly error message when token creation returns a non-JSON error (e.g. 502 HTML)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens') && init?.method === 'POST') {
          return {
            ok: false,
            status: 502,
            json: async () => {
              throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON");
            },
          } as unknown as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());

    const input = screen.getByLabelText(/Token name/i);
    fireEvent.change(input, { target: { value: 'Test Token' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Token/i }));

    await waitFor(() => expect(screen.getByText('Failed to create token.')).toBeInTheDocument());
    expect(screen.queryByText(/Unexpected token/i)).not.toBeInTheDocument();
  });

  it('surfaces the server error message when returned as JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens') && init?.method === 'POST') {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'Token name already in use' }),
          } as unknown as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());

    const input = screen.getByLabelText(/Token name/i);
    fireEvent.change(input, { target: { value: 'Duplicate Token' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Token/i }));

    await waitFor(() => expect(screen.getByText('Token name already in use')).toBeInTheDocument());
  });

  it('populates newly created token into MCP client guide snippet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens') && init?.method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 'tok-1',
              token: 'sanc_full_new_secret_key_789',
              tokenPreview: 'sanc_...789',
              name: 'Claude Agent',
              scopes: ['read', 'write'],
              createdAt: new Date().toISOString(),
            }),
          } as unknown as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());

    const input = screen.getByLabelText(/Token name/i);
    fireEvent.change(input, { target: { value: 'Claude Agent' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Token/i }));

    await waitFor(() => expect(screen.getByText(/Token created/i)).toBeInTheDocument());

    const mcpSnippet = screen.getByTestId('mcp-config-snippet');
    expect(mcpSnippet.textContent).toContain('"MCP_API_TOKEN": "sanc_full_new_secret_key_789"');
  });
});

// Token lifetime: creation lets the caller opt into an expiry instead of
// the token living forever by default.
describe('ApiTokensTab token expiry', () => {
  function stubAdminSessionAndTokens(tokens: any[], onCreate?: (body: any) => any) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ email: 'admin@example.com', isAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/tokens') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 201,
            json: async () => (onCreate ? onCreate(body) : { id: 'tok-new', token: 'sanc_new', tokenPreview: 'sanc_...new', name: body.name, scopes: body.scopes, createdAt: new Date().toISOString(), expiresAt: null }),
          } as unknown as Response;
        }
        if (url.includes('/api/admin/tokens')) {
          return { ok: true, status: 200, json: async () => tokens } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );
  }

  it('defaults the Expires field to "Never" and sends expiresIn: "never" when creating', async () => {
    let capturedBody: any;
    stubAdminSessionAndTokens([], (body) => {
      capturedBody = body;
      return { id: 'tok-new', token: 'sanc_new', tokenPreview: 'sanc_...new', name: body.name, scopes: body.scopes, createdAt: new Date().toISOString(), expiresAt: null };
    });

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());

    expect(screen.getByLabelText(/Expires/i)).toHaveValue('never');

    fireEvent.change(screen.getByLabelText(/Token name/i), { target: { value: 'CI pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Token/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody.expiresIn).toBe('never');
  });

  it('sends the selected expiry option when creating a token', async () => {
    let capturedBody: any;
    stubAdminSessionAndTokens([], (body) => {
      capturedBody = body;
      return { id: 'tok-new', token: 'sanc_new', tokenPreview: 'sanc_...new', name: body.name, scopes: body.scopes, createdAt: new Date().toISOString(), expiresAt: '2026-09-01T00:00:00.000Z' };
    });

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Token name/i), { target: { value: 'CI pipeline' } });
    fireEvent.change(screen.getByLabelText(/Expires/i), { target: { value: '90d' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Token/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody.expiresIn).toBe('90d');
  });

  it('shows "Never" for a token with no expiry, and the formatted date for one that does', async () => {
    stubAdminSessionAndTokens([
      { id: 'tok-1', name: 'Forever token', tokenPreview: 'sanc_...aaaa', scopes: ['read'], createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revoked: false, revokedAt: null, expiresAt: null },
      { id: 'tok-2', name: 'Timed token', tokenPreview: 'sanc_...bbbb', scopes: ['read'], createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revoked: false, revokedAt: null, expiresAt: '2026-12-31T00:00:00.000Z' },
    ]);

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Forever token')).toBeInTheDocument());

    const foreverRow = screen.getByText('Forever token').closest('tr')!;
    // lastUsedAt: null also renders as "Never" — both columns share the fallback.
    expect(within(foreverRow).getAllByText('Never')).toHaveLength(2);

    const timedRow = screen.getByText('Timed token').closest('tr')!;
    expect(within(timedRow).getByText(new Date('2026-12-31T00:00:00.000Z').toLocaleString())).toBeInTheDocument();
  });

  it('shows an "Expired" status for a token past its expiresAt that has not been revoked', async () => {
    // A fixed date in the past, rather than fake timers, so this stays
    // "expired" relative to real wall-clock time whenever the test runs.
    stubAdminSessionAndTokens([
      { id: 'tok-1', name: 'Expired token', tokenPreview: 'sanc_...cccc', scopes: ['read'], createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: null, revoked: false, revokedAt: null, expiresAt: '2020-02-01T00:00:00.000Z' },
    ]);

    render(<ApiTokensTab />);
    await waitFor(() => expect(screen.getByText('Expired token')).toBeInTheDocument());

    const row = screen.getByText('Expired token').closest('tr')!;
    expect(within(row).getByText('Expired')).toBeInTheDocument();
  });
});
