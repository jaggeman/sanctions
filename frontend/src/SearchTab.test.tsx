import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import SearchTab from './SearchTab';

/**
 * issue #130: Search tab extracted out of App.tsx, mirroring UploadTab.tsx's
 * pattern — owns its own state, receives a callback prop (onSelectRecord)
 * for the one cross-cutting concern (opening RecordDetail, which App.tsx
 * still renders at the top level).
 */
function stubFetch(responder: (url: string) => { status: number; body: any }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const { status, body } = responder(url);
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SearchTab', () => {
  it('renders the search heading and input', () => {
    render(<SearchTab onSelectRecord={vi.fn()} />);
    expect(screen.getByText('Search Entities')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search by name/i)).toBeInTheDocument();
  });

  it('shows results, match score, and delisted status after a search', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        results: [
          { id: 'EU-1', source: 'EU', type: 'individual', names: [{ wholeName: 'Vladimir Putin' }], score: 92, matchedAlias: 'V. Putin', status: 'delisted' },
        ],
        totalMatches: 1,
        truncated: false,
      },
    }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Putin' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText('Vladimir Putin')).toBeInTheDocument());
    expect(screen.getByText(/92% match/)).toBeInTheDocument();
    expect(screen.getByText('Delisted')).toBeInTheDocument();
  });

  it('calls onSelectRecord with the clicked result id', async () => {
    stubFetch(() => ({
      status: 200,
      body: { results: [{ id: 'EU-1', source: 'EU', type: 'individual', names: [{ wholeName: 'Test Person' }] }], totalMatches: 1, truncated: false },
    }));

    const onSelectRecord = vi.fn();
    render(<SearchTab onSelectRecord={onSelectRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText('Test Person')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Test Person'));

    expect(onSelectRecord).toHaveBeenCalledWith('EU-1');
  });

  it('shows a truncated-results message when the server reports more matches than returned', async () => {
    stubFetch(() => ({
      status: 200,
      body: { results: [{ id: 'EU-1', source: 'EU', type: 'individual', names: [{ wholeName: 'Test Person' }] }], totalMatches: 500, truncated: true },
    }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/narrow your search/i)).toBeInTheDocument());
  });

  it('shows an error message when the search request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/search failed/i)).toBeInTheDocument());
  });

  it('does not show the generic search-failed error on a 401 (session expiry is App-level, issue #59)', async () => {
    // apiFetch's own onSessionExpired callback (registered by App, not
    // SearchTab) is what actually routes back to Login — SearchTab's own
    // job on a 401 is just to not treat it like a network/parse failure.
    stubFetch(() => ({ status: 401, body: { error: 'Authentication required' } }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^search$/i })).toBeEnabled());
    expect(screen.queryByText(/search failed/i)).not.toBeInTheDocument();
  });
});

