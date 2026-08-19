import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { monitoringRouter } from '../../src/api/routes/monitoring';
import * as monitoringModule from '../../src/monitoring';
import type { MonitoredSubject, MonitoringAlert, MonitoringRunSummary } from '../../src/shared/types';

vi.mock('../../src/monitoring', () => ({
  registerMonitoredSubject: vi.fn(),
  batchRegisterMonitoredSubjects: vi.fn(),
  listMonitoredSubjects: vi.fn(),
  deleteMonitoredSubject: vi.fn(),
  listMonitoringAlerts: vi.fn(),
  resolveMonitoringAlert: vi.fn(),
  runPortfolioScreening: vi.fn(),
}));

vi.mock('../../src/api/middleware/requireAuthOrScope', () => ({
  requireAuthOrScope: () => (req: any, _res: any, next: any) => {
    req.userEmail = 'compliance@bank.test';
    next();
  },
}));

describe('Monitoring API Routes (issue #317)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/monitoring', monitoringRouter);
    vi.clearAllMocks();
  });

  describe('GET /api/monitoring/subjects', () => {
    it('lists monitored subjects', async () => {
      const mockSubjects: MonitoredSubject[] = [
        {
          id: 'sub_1',
          customerId: 'C-001',
          name: 'John Doe',
          type: 'individual',
          portfolio: 'retail',
          status: 'active',
          createdBy: 'admin@test.com',
          createdAt: '2026-08-01T00:00:00Z',
          updatedAt: '2026-08-01T00:00:00Z',
        },
      ];
      vi.mocked(monitoringModule.listMonitoredSubjects).mockResolvedValue(mockSubjects);

      const res = await request(app).get('/api/monitoring/subjects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockSubjects);
      expect(monitoringModule.listMonitoredSubjects).toHaveBeenCalledWith({
        portfolio: undefined,
        status: undefined,
      });
    });
  });

  describe('POST /api/monitoring/subjects', () => {
    it('creates a new monitored subject', async () => {
      const mockSubject: MonitoredSubject = {
        id: 'sub_2',
        customerId: 'C-002',
        name: 'Jane Doe',
        type: 'individual',
        portfolio: 'default',
        status: 'active',
        createdBy: 'compliance@bank.test',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      };
      vi.mocked(monitoringModule.registerMonitoredSubject).mockResolvedValue(mockSubject);

      const res = await request(app)
        .post('/api/monitoring/subjects')
        .send({ customerId: 'C-002', name: 'Jane Doe' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('sub_2');
      expect(monitoringModule.registerMonitoredSubject).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'C-002', name: 'Jane Doe' }),
      );
    });

    it('returns 400 when registration validation fails', async () => {
      vi.mocked(monitoringModule.registerMonitoredSubject).mockRejectedValue(
        new Error('"customerId" is required.'),
      );

      const res = await request(app)
        .post('/api/monitoring/subjects')
        .send({ name: 'Jane Doe' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('"customerId" is required.');
    });
  });

  describe('POST /api/monitoring/subjects/batch', () => {
    it('handles batch customer registration', async () => {
      vi.mocked(monitoringModule.batchRegisterMonitoredSubjects).mockResolvedValue({
        registeredCount: 2,
        errors: [],
      });

      const res = await request(app)
        .post('/api/monitoring/subjects/batch')
        .send({
          subjects: [
            { customerId: 'C-1', name: 'A' },
            { customerId: 'C-2', name: 'B' },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.registeredCount).toBe(2);
    });

    it('returns 400 when subjects is not a non-empty array', async () => {
      const res = await request(app)
        .post('/api/monitoring/subjects/batch')
        .send({ subjects: [] });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/monitoring/subjects/:id', () => {
    it('deletes subject when found', async () => {
      vi.mocked(monitoringModule.deleteMonitoredSubject).mockResolvedValue(true);

      const res = await request(app).delete('/api/monitoring/subjects/sub_1');
      expect(res.status).toBe(200);
    });

    it('returns 404 when subject is not found', async () => {
      vi.mocked(monitoringModule.deleteMonitoredSubject).mockResolvedValue(false);

      const res = await request(app).delete('/api/monitoring/subjects/sub_unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/monitoring/alerts', () => {
    it('lists alerts', async () => {
      const mockAlerts: MonitoringAlert[] = [
        {
          id: 'alt_1',
          subjectId: 'sub_1',
          customerId: 'C-1',
          subjectName: 'Test',
          entityId: 'EU-1',
          score: 88,
          matchedAlias: 'Test',
          source: 'EU',
          status: 'new',
          autoCleared: false,
          createdAt: '2026-08-01T00:00:00Z',
        },
      ];
      vi.mocked(monitoringModule.listMonitoringAlerts).mockResolvedValue(mockAlerts);

      const res = await request(app).get('/api/monitoring/alerts?status=new');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockAlerts);
    });
  });

  describe('POST /api/monitoring/alerts/:id/resolve', () => {
    it('resolves alert with false_positive verdict', async () => {
      const mockAlert: MonitoringAlert = {
        id: 'alt_1',
        subjectId: 'sub_1',
        customerId: 'C-1',
        subjectName: 'Test',
        entityId: 'EU-1',
        score: 88,
        matchedAlias: 'Test',
        source: 'EU',
        status: 'dismissed_false_positive',
        autoCleared: false,
        createdAt: '2026-08-01T00:00:00Z',
      };
      vi.mocked(monitoringModule.resolveMonitoringAlert).mockResolvedValue(mockAlert);

      const res = await request(app)
        .post('/api/monitoring/alerts/alt_1/resolve')
        .send({ verdict: 'false_positive', notes: 'Verified passport' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('dismissed_false_positive');
      expect(monitoringModule.resolveMonitoringAlert).toHaveBeenCalledWith(
        'alt_1',
        expect.objectContaining({
          verdict: 'false_positive',
          notes: 'Verified passport',
          resolvedBy: 'compliance@bank.test',
        }),
      );
    });

    it('rejects invalid verdict value', async () => {
      const res = await request(app)
        .post('/api/monitoring/alerts/alt_1/resolve')
        .send({ verdict: 'maybe' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/monitoring/run', () => {
    it('triggers on-demand screening run', async () => {
      const summary: MonitoringRunSummary = {
        portfolioId: 'retail',
        totalScreened: 10,
        matchesFound: 2,
        newAlerts: 1,
        autoCleared: 1,
        durationMs: 150,
        completedAt: '2026-08-19T10:00:00Z',
      };
      vi.mocked(monitoringModule.runPortfolioScreening).mockResolvedValue(summary);

      const res = await request(app)
        .post('/api/monitoring/run')
        .send({ portfolio: 'retail' });

      expect(res.status).toBe(200);
      expect(res.body.totalScreened).toBe(10);
      expect(monitoringModule.runPortfolioScreening).toHaveBeenCalledWith('retail');
    });
  });
});
