import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import ApiTokensTab from './ApiTokensTab';

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

describe('ApiTokensTab access gating', () => {
  it('shows an admins-only message and no token UI when isAdmin is false', async () => {
    stubFetch({ ok: true, body: { email: 'user@example.com', isAdmin: false } });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText(/restricted to admins/i)).toBeInTheDocument());
    expect(screen.queryByText('Create API Token')).not.toBeInTheDocument();
  });

  it('shows the token management UI when isAdmin is true', async () => {
    stubFetch({ ok: true, body: { email: 'admin@example.com', isAdmin: true } });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText('Create API Token')).toBeInTheDocument());
    expect(screen.queryByText(/restricted to admins/i)).not.toBeInTheDocument();
  });

  it('treats a failed session check (e.g. 401) as denied rather than throwing', async () => {
    stubFetch({ ok: false });
    render(<ApiTokensTab />);

    await waitFor(() => expect(screen.getByText(/restricted to admins/i)).toBeInTheDocument());
  });
});
