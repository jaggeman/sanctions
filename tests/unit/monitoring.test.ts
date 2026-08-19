import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MonitoredSubject, MonitoringAlert, SanctionRecord, Decision } from '../../src/shared/types';
import {
  registerMonitoredSubject,
  batchRegisterMonitoredSubjects,
  listMonitoredSubjects,
  deleteMonitoredSubject,
  listMonitoringAlerts,
  resolveMonitoringAlert,
  runPortfolioScreening,
} from '../../src/monitoring';

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    subjects: new Map<string, MonitoredSubject>(),
    alerts: new Map<string, MonitoringAlert>(),
    decisions: new Map<string, Decision>(),
    records: [] as SanctionRecord[],
  };

  const fakeDb = {
    collection: vi.fn((name: string) => {
      if (name === 'monitoredSubjects') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const s = state.subjects.get(id);
              return { exists: Boolean(s), data: () => s, id };
            }),
            set: vi.fn(async (data: any) => {
              state.subjects.set(id, data);
            }),
            delete: vi.fn(async () => {
              state.subjects.delete(id);
            }),
          })),
          get: vi.fn(async () => ({
            docs: Array.from(state.subjects.values()).map((s) => ({
              id: s.id,
              data: () => s,
            })),
          })),
          where: vi.fn((field: string, _op: string, val: string) => ({
            get: vi.fn(async () => {
              const filtered = Array.from(state.subjects.values()).filter((s: any) => s[field] === val);
              return {
                docs: filtered.map((s) => ({ id: s.id, data: () => s })),
              };
            }),
          })),
        };
      }
      if (name === 'monitoringAlerts') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const a = state.alerts.get(id);
              return { exists: Boolean(a), data: () => a, id };
            }),
            set: vi.fn(async (data: any) => {
              state.alerts.set(id, data);
            }),
          })),
          get: vi.fn(async () => ({
            docs: Array.from(state.alerts.values()).map((a) => ({
              id: a.id,
              data: () => a,
            })),
          })),
          where: vi.fn((field: string, _op: string, val: string) => ({
            get: vi.fn(async () => {
              const filtered = Array.from(state.alerts.values()).filter((a: any) => a[field] === val);
              return {
                docs: filtered.map((a) => ({ id: a.id, data: () => a })),
              };
            }),
          })),
        };
      }
      if (name === 'decisions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const d = state.decisions.get(id);
              return { exists: Boolean(d), data: () => d, id };
            }),
            set: vi.fn(async (data: any) => {
              state.decisions.set(id, data);
            }),
            collection: vi.fn(() => ({
              doc: vi.fn(() => ({
                set: vi.fn(),
              })),
            })),
          })),
          where: vi.fn((field: string, _op: string, val: string) => ({
            get: vi.fn(async () => {
              const filtered = Array.from(state.decisions.values()).filter((d: any) => d[field] === val);
              return {
                forEach: (cb: any) => filtered.forEach((d) => cb({ data: () => d })),
                docs: filtered.map((d) => ({ data: () => d })),
              };
            }),
          })),
        };
      }
      if (name === 'sanctions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const rec = state.records.find((r) => r.id === id);
              return { exists: Boolean(rec), data: () => rec, id };
            }),
          })),
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              docs: state.records.map((r) => ({ id: r.id, data: () => r })),
            })),
          })),
          get: vi.fn(async () => ({
            docs: state.records.map((r) => ({ id: r.id, data: () => r })),
          })),
        };
      }
      if (name === 'overrides') {
        return {
          get: vi.fn(async () => ({ docs: [] })),
        };
      }
      if (name === 'meta') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({ exists: true, data: () => ({ value: 1 }) })),
          })),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  };

  return { fakeDb, state };
});

vi.mock('../../src/shared/firebase', () => ({
  db: fakeDb,
}));

const mockDispatchWebhookEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/webhooks', () => ({
  dispatchWebhookEvent: (...args: any[]) => mockDispatchWebhookEvent(...args),
}));

describe('Ongoing Monitoring & Customer Portfolios (#317)', () => {
  const sampleSanction: SanctionRecord = {
    id: 'EU-900',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Alexander Smirnov', isPrimary: true }],
    searchNames: ['alexander smirnov'],
    createdAt: '2026-01-01T00:00:00Z',
    contentHash: 'hash_smirnov_v1',
  };

  beforeEach(() => {
    state.subjects.clear();
    state.alerts.clear();
    state.decisions.clear();
    state.records = [sampleSanction];
    vi.clearAllMocks();
  });

  describe('Subject Portfolio Registration', () => {
    it('registers a customer subject for continuous monitoring', async () => {
      const subject = await registerMonitoredSubject({
        customerId: 'CUST-001',
        name: 'Alexander Smirnov',
        dob: '1985-04-12',
        country: 'SE',
        portfolio: 'wealth-management',
        createdBy: 'compliance@bank.test',
      });

      expect(subject.id).toMatch(/^sub_/);
      expect(subject.customerId).toBe('CUST-001');
      expect(subject.status).toBe('active');
      expect(subject.portfolio).toBe('wealth-management');
    });

    it('batch registers multiple customer records', async () => {
      const result = await batchRegisterMonitoredSubjects([
        { customerId: 'CUST-001', name: 'John Doe', createdBy: 'admin@test.com' },
        { customerId: 'CUST-002', name: 'Jane Smith', createdBy: 'admin@test.com' },
      ]);

      expect(result.registeredCount).toBe(2);
      expect(state.subjects.size).toBe(2);
    });

    it('lists monitored subjects with filtering', async () => {
      state.subjects.set('sub_1', {
        id: 'sub_1',
        customerId: 'C-1',
        name: 'Alice',
        type: 'individual',
        portfolio: 'retail',
        status: 'active',
        createdBy: 'admin@test.com',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      });
      state.subjects.set('sub_2', {
        id: 'sub_2',
        customerId: 'C-2',
        name: 'Bob',
        type: 'individual',
        portfolio: 'corporate',
        status: 'active',
        createdBy: 'admin@test.com',
        createdAt: '2026-08-02T00:00:00Z',
        updatedAt: '2026-08-02T00:00:00Z',
      });

      const list = await listMonitoredSubjects({ portfolio: 'retail' });
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Alice');
    });

    it('deletes a monitored subject', async () => {
      state.subjects.set('sub_1', {
        id: 'sub_1',
        customerId: 'C-1',
        name: 'Alice',
        type: 'individual',
        status: 'active',
        createdBy: 'admin@test.com',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      });

      const deleted = await deleteMonitoredSubject('sub_1');
      expect(deleted).toBe(true);
      expect(state.subjects.has('sub_1')).toBe(false);
    });
  });

  describe('runPortfolioScreening', () => {
    it('detects sanctions match and creates a new MonitoringAlert with webhook dispatch', async () => {
      state.subjects.set('sub_1', {
        id: 'sub_1',
        customerId: 'CUST-001',
        name: 'Alexander Smirnov',
        type: 'individual',
        status: 'active',
        createdBy: 'admin@test.com',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      });

      const summary = await runPortfolioScreening();

      expect(summary.totalScreened).toBe(1);
      expect(summary.matchesFound).toBe(1);
      expect(summary.newAlerts).toBe(1);
      expect(summary.autoCleared).toBe(0);

      expect(state.alerts.size).toBe(1);
      const alert = Array.from(state.alerts.values())[0];
      expect(alert.customerId).toBe('CUST-001');
      expect(alert.entityId).toBe('EU-900');
      expect(alert.score).toBeGreaterThanOrEqual(70);
      expect(alert.status).toBe('new');

      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        'alert.created',
        expect.objectContaining({ customerId: 'CUST-001', entityId: 'EU-900' }),
      );
    });

    it('suppresses alerts when match is already autoCleared by Decision Memory (#320)', async () => {
      state.subjects.set('sub_1', {
        id: 'sub_1',
        customerId: 'CUST-001',
        name: 'Alexander Smirnov',
        type: 'individual',
        status: 'active',
        createdBy: 'admin@test.com',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      });

      // Pre-existing valid false_positive decision in Decision Memory
      state.decisions.set('EU-900__CUST-001', {
        entityId: 'EU-900',
        subjectId: 'CUST-001',
        verdict: 'false_positive',
        decidedBy: 'compliance@bank.test',
        decidedAt: '2026-08-10T00:00:00Z',
        recordHash: 'hash_smirnov_v1',
      });

      const summary = await runPortfolioScreening();

      expect(summary.totalScreened).toBe(1);
      expect(summary.matchesFound).toBe(1);
      expect(summary.newAlerts).toBe(0);
      expect(summary.autoCleared).toBe(1);
      expect(state.alerts.size).toBe(0);
      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });
  });

  describe('resolveMonitoringAlert', () => {
    it('resolves alert and creates persistent record in Decision Memory (#320)', async () => {
      state.alerts.set('alt_123', {
        id: 'alt_123',
        subjectId: 'sub_1',
        customerId: 'CUST-001',
        subjectName: 'Alexander Smirnov',
        entityId: 'EU-900',
        score: 95,
        matchedAlias: 'Alexander Smirnov',
        source: 'EU',
        status: 'new',
        autoCleared: false,
        createdAt: '2026-08-18T10:00:00Z',
      });

      const resolved = await resolveMonitoringAlert('alt_123', {
        verdict: 'false_positive',
        notes: 'Different birth date verified with passport copy',
        resolvedBy: 'analyst@bank.test',
      });

      expect(resolved.status).toBe('dismissed_false_positive');
      expect(state.alerts.get('alt_123')?.status).toBe('dismissed_false_positive');

      // Assert saved to decision memory
      const savedDecision = state.decisions.get('EU-900__CUST-001');
      expect(savedDecision).toBeDefined();
      expect(savedDecision?.verdict).toBe('false_positive');
      expect(savedDecision?.decidedBy).toBe('analyst@bank.test');
      expect(savedDecision?.recordHash).toBe('hash_smirnov_v1');
    });
  });
});
