import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import UploadTab from './UploadTab';

/**
 * issue #12 (second half, unblocked once #8's diff engine merged): dry-run
 * by default, mode picker, diff preview with counts + sample names, the
 * >20% delist-guard rendered as an explained block with an override path,
 * and the friendly duplicate-upload message (migrated here from App.tsx).
 */

function stubFetch(responder: (url: string, init?: RequestInit) => { status: number; body: any }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const { status, body } = responder(url, init);
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
}

function makeFile(name = 'people.csv', content = 'id;name\n1;Test\n') {
  return new File([content], name, { type: 'text/csv' });
}

async function selectFile(file: File) {
  const input = screen.getByLabelText(/file/i, { selector: 'input' }) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UploadTab — dry-run by default', () => {
  it('automatically previews (dryRun) the file on selection rather than applying it', async () => {
    let capturedBody: FormData | undefined;
    stubFetch((_url, init) => {
      capturedBody = init?.body as FormData;
      return {
        status: 200,
        body: { status: 'dry_run', importId: 'abc', counts: { parsed: 1, uploaded: 0 }, diffs: [] },
      };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('dryRun')).toBe('true');
    // Applying must be a separate, later action — never implied by selecting a file.
    expect(screen.queryByText(/applied/i)).not.toBeInTheDocument();
  });

  it('shows the diff preview with counts once the dry run resolves', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        status: 'dry_run',
        importId: 'abc',
        counts: { parsed: 10, uploaded: 0 },
        diffs: [{
          source: 'EU',
          counts: { parsed: 10, added: 3, updated: 2, unchanged: 4, delisted: 1, skipped: 0 },
          samples: { added: [], updated: [], unchanged: [], delisted: [] },
          toDelistIds: ['EU-9'],
          activeCount: 5,
          guardTripped: false,
        }],
      },
    }));

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByText(/3/)).toBeInTheDocument());
    expect(screen.getByText(/added/i)).toBeInTheDocument();
    expect(screen.getByText(/updated/i)).toBeInTheDocument();
    expect(screen.getByText(/unchanged/i)).toBeInTheDocument();
  });

  it('shows sample record names, not just counts', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        status: 'dry_run',
        importId: 'abc',
        counts: { parsed: 1, uploaded: 0 },
        diffs: [{
          source: 'EU',
          counts: { parsed: 1, added: 1, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
          samples: { added: [{ id: 'EU-new', primaryName: 'Freshly Added Person' }], updated: [], unchanged: [], delisted: [] },
          toDelistIds: [],
          activeCount: 0,
          guardTripped: false,
        }],
      },
    }));

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByText('Freshly Added Person')).toBeInTheDocument());
  });

  it('requires a separate Apply click before anything is written', async () => {
    let applyCalled = false;
    stubFetch((_url, init) => {
      const isDryRun = (init?.body as FormData).get('dryRun') === 'true';
      if (!isDryRun) applyCalled = true;
      return {
        status: 200,
        body: isDryRun
          ? { status: 'dry_run', importId: 'abc', counts: { parsed: 1, uploaded: 0 }, diffs: [] }
          : { status: 'applied', importId: 'abc', counts: { parsed: 1, uploaded: 1 } },
      };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => screen.getByRole('button', { name: /apply/i }));

    expect(applyCalled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(applyCalled).toBe(true));
  });
});

describe('UploadTab — mode picker', () => {
  it('defaults to append mode', async () => {
    let capturedBody: FormData | undefined;
    stubFetch((_url, init) => {
      capturedBody = init?.body as FormData;
      return { status: 200, body: { status: 'dry_run', importId: 'abc', counts: { parsed: 1, uploaded: 0 }, diffs: [] } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('mode')).toBe('append');
  });

  it('explains the consequence of sync mode before the user picks it', () => {
    render(<UploadTab onViewImport={vi.fn()} />);
    expect(screen.getByText(/replaces|delisted|missing/i)).toBeInTheDocument();
  });

  it('sends sync mode when explicitly selected', async () => {
    let capturedBody: FormData | undefined;
    stubFetch((_url, init) => {
      capturedBody = init?.body as FormData;
      return { status: 200, body: { status: 'dry_run', importId: 'abc', counts: { parsed: 1, uploaded: 0 }, diffs: [] } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    fireEvent.mouseDown(screen.getByLabelText(/mode/i));
    fireEvent.click(screen.getByRole('option', { name: /sync/i }));
    await selectFile(makeFile());

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('mode')).toBe('sync');
  });
});

describe('UploadTab — delist guard', () => {
  const guardTrippedDiff = {
    source: 'EU',
    counts: { parsed: 2, added: 0, updated: 0, unchanged: 2, delisted: 8, skipped: 0 },
    samples: { added: [], updated: [], unchanged: [], delisted: [{ id: 'EU-1', primaryName: 'About To Be Delisted' }] },
    toDelistIds: ['EU-1', 'EU-2', 'EU-3', 'EU-4', 'EU-5', 'EU-6', 'EU-7', 'EU-8'],
    activeCount: 10,
    guardTripped: true,
  };

  it('renders a prominent, explained block rather than a toast when the guard trips', async () => {
    stubFetch(() => ({
      status: 200,
      body: { status: 'dry_run', importId: 'abc', counts: { parsed: 2, uploaded: 0 }, diffs: [guardTrippedDiff] },
    }));

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByText(/refus|guard|override|confirm/i)).toBeInTheDocument());
    expect(screen.getByText(/8 of 10/)).toBeInTheDocument();
  });

  it('disables Apply until the override is explicitly confirmed', async () => {
    stubFetch(() => ({
      status: 200,
      body: { status: 'dry_run', importId: 'abc', counts: { parsed: 2, uploaded: 0 }, diffs: [guardTrippedDiff] },
    }));

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled());
  });

  it('sends force=true once the override checkbox is checked, and enables Apply', async () => {
    let capturedBody: FormData | undefined;
    stubFetch((_url, init) => {
      const body = init?.body as FormData;
      if (body.get('dryRun') === 'true') {
        return { status: 200, body: { status: 'dry_run', importId: 'abc', counts: { parsed: 2, uploaded: 0 }, diffs: [guardTrippedDiff] } };
      }
      capturedBody = body;
      return { status: 200, body: { status: 'applied', importId: 'abc', counts: { parsed: 2, uploaded: 2 } } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /override|understand|confirm/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: /override|understand|confirm/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('force')).toBe('true');
  });

  it('does not require the override when the guard has not tripped', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        status: 'dry_run', importId: 'abc', counts: { parsed: 1, uploaded: 0 },
        diffs: [{ ...guardTrippedDiff, guardTripped: false, toDelistIds: [], counts: { ...guardTrippedDiff.counts, delisted: 0 } }],
      },
    }));

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());
  });
});

describe('UploadTab — duplicate upload', () => {
  it('shows a friendly message with a link to the original import, not a generic failure', async () => {
    const onViewImport = vi.fn();
    stubFetch(() => ({
      status: 409,
      body: { error: 'Identical file already imported as import #earlier-id.', duplicateOfImportId: 'earlier-id' },
    }));

    render(<UploadTab onViewImport={onViewImport} />);
    await selectFile(makeFile());

    await waitFor(() => expect(screen.getByText(/already imported/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /view import/i }));
    expect(onViewImport).toHaveBeenCalledWith('earlier-id');
  });
});

describe('UploadTab — applied outcome', () => {
  it('shows a success message with the final counts after Apply', async () => {
    stubFetch((_url, init) => {
      const body = init?.body as FormData;
      if (body.get('dryRun') === 'true') {
        return { status: 200, body: { status: 'dry_run', importId: 'abc', counts: { parsed: 5, uploaded: 0 }, diffs: [] } };
      }
      return { status: 200, body: { status: 'applied', importId: 'abc', counts: { parsed: 5, uploaded: 5 } } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => screen.getByRole('button', { name: /apply/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(screen.getByText(/applied/i)).toBeInTheDocument());
  });
});
