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

describe('UploadTab — batch upload (issue #289)', () => {
  it('automatically previews all files with dryRun: true and requires Apply click before uploading', async () => {
    const file1 = makeFile('file1.xml', '<CONSOLIDATED_LIST/>');
    const file2 = makeFile('file2.xml', '<sdnList/>');

    const dryRunCalls: string[] = [];
    const applyCalls: string[] = [];

    stubFetch((_url, init) => {
      const body = init?.body as FormData;
      const file = body.get('file') as File;
      const isDryRun = body.get('dryRun') === 'true';

      if (isDryRun) {
        dryRunCalls.push(file.name);
        if (file.name === 'file1.xml') {
          return {
            status: 200,
            body: {
              status: 'dry_run',
              importId: 'abc1',
              counts: { parsed: 10, uploaded: 0 },
              diffs: [{
                source: 'EU',
                counts: { parsed: 10, added: 5, updated: 2, unchanged: 3, delisted: 0, skipped: 0 },
                samples: { added: [], updated: [], unchanged: [], delisted: [] },
                toDelistIds: [],
                activeCount: 3,
                guardTripped: false,
              }],
            },
          };
        }
        return { status: 409, body: { duplicateOfImportId: 'earlier-99' } };
      }

      applyCalls.push(file.name);
      return { status: 200, body: { status: 'applied', counts: { parsed: 10, uploaded: 10 } } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    const input = screen.getByLabelText(/file/i, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file1, file2] } });

    // Dry runs should run automatically for both files
    await waitFor(() => expect(dryRunCalls).toEqual(['file1.xml', 'file2.xml']));
    // No apply calls should happen yet!
    expect(applyCalls).toEqual([]);

    // The batch preview table should be visible with preview counts/statuses
    expect(screen.getByText(/Batch Upload/i)).toBeInTheDocument();
    expect(screen.getByText('file1.xml')).toBeInTheDocument();
    expect(screen.getByText('file2.xml')).toBeInTheDocument();
    expect(screen.getByText('Skipped (Duplicate)')).toBeInTheDocument();

    // Clicking Apply All should trigger the actual upload
    const applyBtn = screen.getByRole('button', { name: /apply/i });
    expect(applyBtn).not.toBeDisabled();
    fireEvent.click(applyBtn);

    await waitFor(() => expect(applyCalls).toEqual(['file1.xml']));
    await waitFor(() => expect(screen.getByText(/Batch complete/i)).toBeInTheDocument());
  });

  it('surfaces delist guard warning for batch upload and disables Apply until override is checked', async () => {
    const file1 = makeFile('file1.xml', '<CONSOLIDATED_LIST/>');
    const file2 = makeFile('file2.xml', '<sdnList/>');

    const appliedForces: string[] = [];

    stubFetch((_url, init) => {
      const body = init?.body as FormData;
      const file = body.get('file') as File;
      const isDryRun = body.get('dryRun') === 'true';

      if (isDryRun) {
        if (file.name === 'file1.xml') {
          return {
            status: 200,
            body: {
              status: 'dry_run',
              importId: 'abc1',
              counts: { parsed: 10, uploaded: 0 },
              diffs: [{
                source: 'EU',
                counts: { parsed: 10, added: 0, updated: 0, unchanged: 2, delisted: 8, skipped: 0 },
                samples: { added: [], updated: [], unchanged: [], delisted: [] },
                toDelistIds: ['EU-1'],
                activeCount: 10,
                guardTripped: true,
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            status: 'dry_run',
            importId: 'abc2',
            counts: { parsed: 5, uploaded: 0 },
            diffs: [],
          },
        };
      }

      appliedForces.push(body.get('force') as string);
      return { status: 200, body: { status: 'applied', counts: { parsed: 10, uploaded: 10 } } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    const input = screen.getByLabelText(/file/i, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file1, file2] } });

    await waitFor(() => expect(screen.getByText(/Refusing to delist/i)).toBeInTheDocument());
    const applyBtn = screen.getByRole('button', { name: /apply/i });
    expect(applyBtn).toBeDisabled();

    // Check override
    const checkbox = screen.getByRole('checkbox', { name: /override|understand|confirm/i });
    fireEvent.click(checkbox);

    expect(applyBtn).not.toBeDisabled();
    fireEvent.click(applyBtn);

    await waitFor(() => expect(appliedForces.length).toBe(2));
    expect(appliedForces[0]).toBe('true');
  });
});

describe('UploadTab — stale preview invalidation (#163)', () => {
  function stubEchoingDryRun(onApply: (body: FormData) => void) {
    const dryRunSources: string[] = [];
    stubFetch((_url, init) => {
      const body = init?.body as FormData;
      if (body.get('dryRun') === 'true') {
        dryRunSources.push((body.get('source') as string) || 'AUTO');
        return {
          status: 200,
          body: {
            status: 'dry_run',
            importId: 'abc',
            counts: { parsed: 1, uploaded: 0 },
            diffs: [{
              source: (body.get('source') as string) || 'AUTO',
              counts: { parsed: 1, added: 1, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
              samples: { added: [], updated: [], unchanged: [], delisted: [] },
              toDelistIds: [],
              activeCount: 0,
              guardTripped: false,
            }],
          },
        };
      }
      onApply(body);
      return { status: 200, body: { status: 'applied', importId: 'abc', counts: { parsed: 1, uploaded: 1 } } };
    });
    return dryRunSources;
  }

  it('re-runs the dry run (not a stale one) when Source is changed after a preview', async () => {
    const dryRunSources = stubEchoingDryRun(() => {});

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => expect(dryRunSources).toEqual(['AUTO']));

    fireEvent.mouseDown(screen.getByLabelText(/^source/i));
    fireEvent.click(screen.getByRole('option', { name: /^UN$/i }));

    // A fresh dry run against the new source must fire — not a reuse of the stale AUTO preview.
    await waitFor(() => expect(dryRunSources).toEqual(['AUTO', 'UN']));
  });

  it('re-runs the dry run when Mode is changed after a preview, and Apply then posts the new mode', async () => {
    let capturedBody: FormData | undefined;
    stubEchoingDryRun((body) => {
      capturedBody = body;
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());

    fireEvent.mouseDown(screen.getByLabelText(/^mode/i));
    fireEvent.click(screen.getByRole('option', { name: /^sync$/i }));

    // While the re-run is in flight the stale preview/Apply must not be usable.
    await waitFor(() => expect(screen.queryByRole('button', { name: /apply/i })).toBeFalsy());

    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('mode')).toBe('sync');
  });

  it('never lets Apply post a source different from the one that produced the displayed preview', async () => {
    let capturedBody: FormData | undefined;
    const dryRunSources = stubEchoingDryRun((body) => {
      capturedBody = body;
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    await selectFile(makeFile());
    await waitFor(() => expect(dryRunSources).toEqual(['AUTO']));

    fireEvent.mouseDown(screen.getByLabelText(/^source/i));
    fireEvent.click(screen.getByRole('option', { name: /^UN$/i }));

    await waitFor(() => expect(dryRunSources).toEqual(['AUTO', 'UN']));
    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.get('source')).toBe('UN');
  });
});

describe('UploadTab — sync official sources', () => {
  it('calls POST /api/import with official sources when button clicked', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: any;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return { status: 200, body: { success: true, importId: 'imp_456' } };
    });

    render(<UploadTab onViewImport={vi.fn()} />);
    const syncButton = screen.getByRole('button', { name: /sync official sources/i });
    fireEvent.click(syncButton);

    await waitFor(() => expect(capturedUrl).toBe('/api/import'));
    expect(capturedBody.sources).toEqual(['EU', 'UN', 'US', 'UK']);
    await waitFor(() => expect(screen.getByText(/Official sync started/i)).toBeInTheDocument());
  });
});
