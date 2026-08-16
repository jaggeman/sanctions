import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

  // Repo owner asked for the log list to stay short — cap it to the 5 most
  // recent entries (for whichever filter is selected) rather than rendering
  // every buffered log unbounded.
  it('caps the log table to the 5 most recent entries under the ALL filter', async () => {
    const manyLogs = {
      logs: Array.from({ length: 8 }, (_, i) => ({
        id: `log-${i + 1}`,
        timestamp: `2026-08-16T08:0${i}:00Z`,
        level: 'info' as const,
        module: 'importer.uploader',
        message: `Log entry number ${i + 1}`,
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/system/status')) {
          return { ok: true, status: 200, json: async () => mockStatus } as Response;
        }
        if (url.includes('/api/system/logs')) {
          return { ok: true, status: 200, json: async () => manyLogs } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<DriftStatusTab />);

    await waitFor(() => {
      expect(screen.getByText(/Log entry number 8/)).toBeInTheDocument();
    });

    // The 5 most recent (4-8) show; the 3 oldest (1-3) are capped out.
    for (const n of [4, 5, 6, 7, 8]) {
      expect(screen.getByText(`Log entry number ${n}`)).toBeInTheDocument();
    }
    for (const n of [1, 2, 3]) {
      expect(screen.queryByText(`Log entry number ${n}`)).not.toBeInTheDocument();
    }
  });

  it('caps to the 5 most recent entries per level, not just overall', async () => {
    const manyErrorLogs = {
      logs: Array.from({ length: 7 }, (_, i) => ({
        id: `err-${i + 1}`,
        timestamp: `2026-08-16T09:0${i}:00Z`,
        level: 'error' as const,
        module: 'importer.fetcher',
        message: `Error entry number ${i + 1}`,
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/system/status')) {
          return { ok: true, status: 200, json: async () => mockStatus } as Response;
        }
        if (url.includes('/api/system/logs')) {
          return { ok: true, status: 200, json: async () => manyErrorLogs } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );

    render(<DriftStatusTab />);

    await waitFor(() => {
      expect(screen.getByText(/Error entry number 7/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /error/i }));

    for (const n of [3, 4, 5, 6, 7]) {
      expect(screen.getByText(`Error entry number ${n}`)).toBeInTheDocument();
    }
    for (const n of [1, 2]) {
      expect(screen.queryByText(`Error entry number ${n}`)).not.toBeInTheDocument();
    }
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
