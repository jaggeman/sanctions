import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
    // Score is its own sortable column now, so it reads "92%" rather than the
    // card layout's "92% match — <alias>"; the matched alias moved to the
    // "Matched on" column beside it.
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('V. Putin')).toBeInTheDocument();
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

  it('issue #147: shows an error message and suppresses "No results found" on a 500 response', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'Internal server error', details: 'Firestore unavailable' } }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Putin' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());
    expect(screen.queryByText(/No results found/i)).not.toBeInTheDocument();
  });

  it('issue #147: shows an error message and suppresses "No results found" on a 403 response', async () => {
    stubFetch(() => ({ status: 403, body: { error: 'Read scope required' } }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'Putin' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/Read scope required/i)).toBeInTheDocument());
    expect(screen.queryByText(/No results found/i)).not.toBeInTheDocument();
  });
});

/**
 * Results are rendered as a dense table rather than a card grid. The card
 * layout put three hits per row and pushed everything else below the fold,
 * which makes scanning a result set — the actual job here — harder than it
 * needs to be: an analyst comparing hits wants score, source, type and name
 * aligned in columns, not repeated as chips inside each card.
 *
 * Scoring/recall behaviour is deliberately NOT touched here; that is #239.
 */
describe('SearchTab results table', () => {
  const threeResults = {
    status: 200,
    body: {
      results: [
        { id: 'UK-1', source: 'UK', type: 'vessel', names: [{ wholeName: 'INDA' }], score: 93, matchedAlias: 'INDA', status: 'active' },
        { id: 'US-1', source: 'US', type: 'vessel', names: [{ wholeName: 'LAMD' }, { wholeName: 'TAI HE' }], score: 85, matchedAlias: 'LAMD', status: 'active' },
        { id: 'EU-9', source: 'EU', type: 'individual', names: [{ wholeName: 'Anna Berg' }], score: 71, matchedAlias: 'Anna Berg', status: 'delisted', birthDates: [{ year: 1970 }] },
      ],
      totalMatches: 3,
      truncated: false,
    },
  };

  async function searchAndWait(body = threeResults) {
    stubFetch(() => body);
    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'linda' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  }

  it('renders results in a table with column headers', async () => {
    await searchAndWait();

    expect(screen.getByRole('columnheader', { name: /score/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^name/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /source/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /type/i })).toBeInTheDocument();
  });

  it('renders one row per result, plus the header row', async () => {
    await searchAndWait();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('shows name, score, source, type, aliases and birth date in the row', async () => {
    await searchAndWait();

    const row = screen.getByText('LAMD').closest('tr')!;
    expect(within(row).getByText('85%')).toBeInTheDocument();
    expect(within(row).getByText('US')).toBeInTheDocument();
    expect(within(row).getByText('vessel')).toBeInTheDocument();
    expect(within(row).getByText(/TAI HE/)).toBeInTheDocument();

    const delistedRow = screen.getByText('Anna Berg').closest('tr')!;
    expect(within(delistedRow).getByText(/delisted/i)).toBeInTheDocument();
    expect(within(delistedRow).getByText(/1970/)).toBeInTheDocument();
  });

  it('calls onSelectRecord with the id of the clicked row', async () => {
    stubFetch(() => threeResults);
    const onSelectRecord = vi.fn();
    render(<SearchTab onSelectRecord={onSelectRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'linda' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText('LAMD')).toBeInTheDocument());
    fireEvent.click(screen.getByText('LAMD').closest('tr')!);

    expect(onSelectRecord).toHaveBeenCalledWith('US-1');
  });

  it('sorts by name when the Name header is clicked, and reverses on a second click', async () => {
    await searchAndWait();

    fireEvent.click(screen.getByRole('columnheader', { name: /^name/i }));
    let names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent);
    expect(names[0]).toContain('Anna Berg');

    fireEvent.click(screen.getByRole('columnheader', { name: /^name/i }));
    names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent);
    expect(names[0]).toContain('LAMD');
  });

  it('sorts by score descending by default, and ascending once toggled', async () => {
    await searchAndWait();

    const scoresOf = () =>
      screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

    expect(scoresOf()).toEqual(['93%', '85%', '71%']);

    fireEvent.click(screen.getByRole('columnheader', { name: /score/i }));
    expect(scoresOf()).toEqual(['71%', '85%', '93%']);
  });

  it('keeps the truncated-results message and CSV export above the table', async () => {
    await searchAndWait({
      status: 200,
      body: { ...threeResults.body, totalMatches: 500, truncated: true },
    });

    expect(screen.getByText(/narrow your search/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export results/i })).toBeInTheDocument();
  });

  it('renders no table at all when there are no results', async () => {
    stubFetch(() => ({ status: 200, body: { results: [], totalMatches: 0, truncated: false } }));

    render(<SearchTab onSelectRecord={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/No results found/i)).toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

