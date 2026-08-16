import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import DriftStatusTab from './DriftStatusTab';

const mockStatus = {
  status: 'healthy',
  serverTime: '2026-08-16T09:00:00.000Z',
  uptimeSeconds: 7200,
  environment: 'production',
  database: {
    connected: true,
    projectId: 'sanctions-app-dev-01',
    latencyMs: 14,
    counts: {
      UN: 1011,
      UK: 6334,
      EU: 6234,
      US: 19199,
      total: 32778,
    },
  },
  functions: [
    {
      name: 'api',
      type: 'HTTP / Cloud Run',
      region: 'us-central1',
      status: 'healthy',
    },
    {
      name: 'scheduledSourceFetch',
      type: 'PubSub / Cloud Scheduler',
      region: 'us-central1',
      status: 'active',
    },
  ],
  releases: [
    {
      version: 'v1.4.2',
      timestamp: '2026-08-16T08:58:22Z',
      deployedBy: 'jaggeman (Admin)',
      commitSha: '6735d12',
      environment: 'sanctions-app-dev-01',
      summary: 'Remember Login Email, Multi-Upload UI, CSV Parser Security',
    },
    {
      version: 'v1.4.1',
      timestamp: '2026-08-16T07:35:10Z',
      deployedBy: 'jaggeman (Admin)',
      commitSha: '4991557',
      environment: 'sanctions-app-dev-01',
      summary: 'Negative search limit validation',
    },
  ],
};

const mockLogs = {
  logs: [
    {
      id: 'log-1',
      timestamp: '2026-08-16T08:50:00Z',
      level: 'info',
      module: 'importer.uploader',
      message: 'Sanctions sync completed for UN',
    },
    {
      id: 'log-2',
      timestamp: '2026-08-16T08:52:00Z',
      level: 'warn',
      module: 'importer.parsers.csv',
      message: 'Skipped invalid row without ID',
    },
  ],
};

describe('DriftStatusTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('renders system health, database counts, error logs, and releases', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/system/status')) {
          return { ok: true, status: 200, json: async () => mockStatus } as Response;
        }
        if (url.includes('/api/system/logs')) {
          return { ok: true, status: 200, json: async () => mockLogs } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<DriftStatusTab />);

    await waitFor(() => {
      expect(screen.getByText(/System Status & Health/i)).toBeInTheDocument();
    });

    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.getAllByText(/records/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/v1\.4\.2/)).toBeInTheDocument();
    expect(screen.getAllByText(/jaggeman/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Sanctions sync completed for UN/i)).toBeInTheDocument();
  });

  it('renders error alert on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return { ok: false, status: 500, json: async () => ({ error: 'Internal error' }) } as Response;
      }),
    );

    render(<DriftStatusTab />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load system status/i)).toBeInTheDocument();
    });
  });
});

/**
 * The "Module / Function" log table had hardcoded 180px/100px/180px column
 * widths (issue #264, item 1) that force horizontal scroll under ~460px,
 * before the Event/Message column even gets any room. Fixed by dropping to
 * fewer visible columns under the `sm` breakpoint, matching the
 * useMediaQuery + window.matchMedia-stub pattern PR #265 established for
 * App.tsx's own responsive tab bar/header.
 */
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

function stubFetchOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/system/status')) {
        return { ok: true, status: 200, json: async () => mockStatus } as Response;
      }
      if (url.includes('/api/system/logs')) {
        return { ok: true, status: 200, json: async () => mockLogs } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

describe('DriftStatusTab — responsive log table (issue #264, item 1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows all four log-table columns on a normal-width viewport', async () => {
    const restore = stubViewportMatches(false);
    stubFetchOk();
    render(<DriftStatusTab />);

    await waitFor(() => expect(screen.getByText(/Sanctions sync completed for UN/i)).toBeInTheDocument());

    expect(screen.getByRole('columnheader', { name: 'Timestamp' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Module / Function' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Level' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Event / Message' })).toBeInTheDocument();
    restore();
  });

  it('drops the Timestamp and Module/Function columns on a narrow viewport, keeping only Level and Event/Message', async () => {
    const restore = stubViewportMatches(true);
    stubFetchOk();
    render(<DriftStatusTab />);

    await waitFor(() => expect(screen.getByText(/Sanctions sync completed for UN/i)).toBeInTheDocument());

    expect(screen.queryByRole('columnheader', { name: 'Timestamp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Module / Function' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Level' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Event / Message' })).toBeInTheDocument();
    restore();
  });

  it('still surfaces the module name on a narrow viewport, folded into the message cell rather than silently dropped', async () => {
    const restore = stubViewportMatches(true);
    stubFetchOk();
    render(<DriftStatusTab />);

    await waitFor(() => expect(screen.getByText(/Sanctions sync completed for UN/i)).toBeInTheDocument());

    expect(screen.getByText(/importer\.uploader/)).toBeInTheDocument();
    restore();
  });
});
