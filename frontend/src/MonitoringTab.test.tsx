import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import MonitoringTab from './MonitoringTab';

function stubFetch(subjects: any[] = [], alerts: any[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';

      if (url.includes('/api/monitoring/subjects') && method === 'GET') {
        return { ok: true, status: 200, json: async () => subjects } as Response;
      }
      if (url.includes('/api/monitoring/alerts') && method === 'GET') {
        return { ok: true, status: 200, json: async () => alerts } as Response;
      }
      if (url.includes('/api/monitoring/run') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalScreened: 1,
            matchesFound: 1,
            newAlerts: 1,
            autoCleared: 0,
            durationMs: 45,
            completedAt: new Date().toISOString(),
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MonitoringTab Component (issue #317)', () => {
  it('renders summary cards and alerts table', async () => {
    stubFetch(
      [
        {
          id: 'sub_1',
          customerId: 'CUST-001',
          name: 'Alexander Smirnov',
          type: 'individual',
          status: 'active',
          portfolio: 'retail',
          createdAt: '2026-08-01T00:00:00Z',
        },
      ],
      [
        {
          id: 'alt_1',
          subjectId: 'sub_1',
          customerId: 'CUST-001',
          subjectName: 'Alexander Smirnov',
          entityId: 'EU-900',
          score: 95,
          matchedAlias: 'Alexander Smirnov',
          source: 'EU',
          status: 'new',
          autoCleared: false,
          createdAt: '2026-08-01T00:00:00Z',
        },
      ],
    );

    render(<MonitoringTab onSelectRecord={vi.fn()} />);

    expect(screen.getByText(/Ongoing Monitoring & Portfolios/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('CUST-001')).toBeInTheDocument();
      expect(screen.getByText('95%')).toBeInTheDocument();
    });
  });

  it('triggers on-demand portfolio screening run', async () => {
    stubFetch([
      {
        id: 'sub_1',
        customerId: 'CUST-001',
        name: 'Alexander Smirnov',
        type: 'individual',
        status: 'active',
        portfolio: 'retail',
        createdAt: '2026-08-01T00:00:00Z',
      },
    ]);

    render(<MonitoringTab onSelectRecord={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Run Screening Now')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Run Screening Now'));

    await waitFor(() => {
      expect(screen.getByText(/Screening run completed/i)).toBeInTheDocument();
    });
  });
});
