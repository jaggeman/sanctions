import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import RecordDetail from './RecordDetail';

/**
 * RecordDetail is a dialog shown when a search result is clicked (issue #12).
 * It fetches the full record (GET /api/sanctions/:id) and its version trail
 * (GET /api/sanctions/:id/versions) whenever recordId changes.
 */
function stubFetch(record: any, versions: any[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/versions')) {
        return { ok: true, json: async () => versions } as Response;
      }
      if (url.includes('/api/sanctions/')) {
        return { ok: true, json: async () => record } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecordDetail', () => {
  it('renders nothing when recordId is null', () => {
    render(<RecordDetail recordId={null} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the primary name and an Active status once loaded', async () => {
    stubFetch({ id: 'EU-1', names: [{ wholeName: 'Test Person', strong: true }], source: 'EU', type: 'individual' });
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Test Person').length).toBeGreaterThan(0));
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows a Delisted status with the delistedAt date', async () => {
    stubFetch({
      id: 'EU-1',
      names: [{ wholeName: 'Test Person', strong: true }],
      status: 'delisted',
      delistedAt: '2026-01-15T00:00:00.000Z',
    });
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Delisted')).toBeInTheDocument());
  });

  it('renders structured names with the strong/weak distinction', async () => {
    stubFetch({
      id: 'EU-1',
      names: [
        { wholeName: 'Test Person', strong: true },
        { wholeName: 'Alias Person', strong: false },
      ],
    });
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Alias Person')).toBeInTheDocument());
    expect(screen.getAllByText(/strong/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/weak/i).length).toBeGreaterThan(0);
  });

  it('renders identifications with their reliability flags', async () => {
    stubFetch({
      id: 'EU-1',
      names: [{ wholeName: 'Test Person', strong: true }],
      identifications: [{ number: 'X123456', typeDescription: 'Passport', knownFalse: true }],
    });
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/X123456/)).toBeInTheDocument());
    expect(screen.getByText(/known false/i)).toBeInTheDocument();
  });

  it('renders regulation info with a link to its publication URL', async () => {
    stubFetch({
      id: 'EU-1',
      names: [{ wholeName: 'Test Person', strong: true }],
      regulation: { numberTitle: 'Council Regulation (EU) 269/2014', url: 'https://example.com/reg' },
    });
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/269\/2014/)).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /269\/2014/ });
    expect(link).toHaveAttribute('href', 'https://example.com/reg');
  });

  it('renders the version trail', async () => {
    stubFetch(
      { id: 'EU-1', names: [{ wholeName: 'Test Person', strong: true }] },
      [
        { importId: 'import-2', changedAt: '2026-02-01T00:00:00.000Z', changeType: 'updated' },
        { importId: 'import-1', changedAt: '2026-01-01T00:00:00.000Z', changeType: 'created' },
      ],
    );
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/updated/i)).toBeInTheDocument());
    expect(screen.getByText(/created/i)).toBeInTheDocument();
  });

  it('calls onClose when the dialog is dismissed', async () => {
    stubFetch({ id: 'EU-1', names: [{ wholeName: 'Test Person', strong: true }] });
    const onClose = vi.fn();
    render(<RecordDetail recordId="EU-1" onClose={onClose} />);

    await waitFor(() => expect(screen.getAllByText('Test Person').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error message rather than crashing when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    render(<RecordDetail recordId="EU-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
  });
});
