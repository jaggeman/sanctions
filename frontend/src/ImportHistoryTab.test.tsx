import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import ImportHistoryTab from './ImportHistoryTab';

/**
 * ImportHistoryTab lists past imports (GET /api/imports, issue #12) newest
 * first, and opens a detail view for one on click.
 */
function stubFetch(imports: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/imports')) {
        return { ok: true, json: async () => imports } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
}

const APPLIED = {
  importId: 'abc123',
  filename: 'eu_list.xml',
  source: 'EU',
  format: 'eu-xml-1.1',
  uploadedAt: '2026-08-15T10:00:00.000Z',
  uploadedBy: 'analyst@example.com',
  status: 'applied',
  counts: { parsed: 100, uploaded: 100 },
};

const FAILED = {
  importId: 'def456',
  filename: 'broken.csv',
  source: 'PEP',
  format: 'csv',
  uploadedAt: '2026-08-14T10:00:00.000Z',
  uploadedBy: 'analyst@example.com',
  status: 'failed',
  error: 'Parse error at line 4',
};

const REJECTED = {
  importId: 'ghi789',
  filename: 'dup.csv',
  source: 'PEP',
  format: 'csv',
  uploadedAt: '2026-08-13T10:00:00.000Z',
  uploadedBy: 'analyst@example.com',
  status: 'rejected',
  duplicateOfImportId: 'abc123',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportHistoryTab', () => {
  it('shows a loading state then the list of imports', async () => {
    stubFetch([APPLIED, FAILED]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText('eu_list.xml')).toBeInTheDocument());
    expect(screen.getByText('broken.csv')).toBeInTheDocument();
  });

  it('shows a message when there is no import history yet', async () => {
    stubFetch([]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText(/no imports yet/i)).toBeInTheDocument());
  });

  it('shows a status chip per row', async () => {
    stubFetch([APPLIED, FAILED, REJECTED]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText('applied')).toBeInTheDocument());
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('rejected')).toBeInTheDocument();
  });

  it('opens a detail view with the error message when a failed row is clicked', async () => {
    stubFetch([FAILED]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText('broken.csv')).toBeInTheDocument());
    fireEvent.click(screen.getByText('broken.csv'));

    await waitFor(() => expect(screen.getByText(/parse error at line 4/i)).toBeInTheDocument());
  });

  it('opens a detail view referencing the original import for a rejected row', async () => {
    stubFetch([REJECTED]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText('dup.csv')).toBeInTheDocument());
    fireEvent.click(screen.getByText('dup.csv'));

    await waitFor(() => expect(screen.getByText(/abc123/)).toBeInTheDocument());
  });

  it('shows parsed/uploaded counts for an applied import', async () => {
    stubFetch([APPLIED]);
    render(<ImportHistoryTab />);

    await waitFor(() => expect(screen.getByText('eu_list.xml')).toBeInTheDocument());
    fireEvent.click(screen.getByText('eu_list.xml'));

    await waitFor(() => expect(screen.getByText(/100/)).toBeInTheDocument());
  });

  it('auto-opens the detail for focusImportId once loaded', async () => {
    stubFetch([APPLIED, REJECTED]);
    render(<ImportHistoryTab focusImportId="abc123" />);

    await waitFor(() => expect(screen.getByText(/parsed/i)).toBeInTheDocument());
  });
});
