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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriftStatusTab', () => {
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
      expect(screen.getByText(/Drift status & Systemhälsa/i)).toBeInTheDocument();
    });

    expect(screen.getByText('DRIFT NORMAL')).toBeInTheDocument();
    expect(screen.getByText('ANSLUTEN')).toBeInTheDocument();
    expect(screen.getAllByText(/poster/i).length).toBeGreaterThanOrEqual(1);
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
      expect(screen.getByText(/Kunde inte hämta systemstatus/i)).toBeInTheDocument();
    });
  });
});
