import { Router } from 'express';
import {
  registerMonitoredSubject,
  batchRegisterMonitoredSubjects,
  listMonitoredSubjects,
  deleteMonitoredSubject,
  listMonitoringAlerts,
  resolveMonitoringAlert,
  runPortfolioScreening,
} from '../../monitoring';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';

export const monitoringRouter = Router();

/**
 * GET /api/monitoring/subjects
 * List all subjects in customer monitoring portfolios.
 */
monitoringRouter.get('/subjects', requireAuthOrScope('monitoring:read'), async (req, res): Promise<any> => {
  const { portfolio, status } = req.query;
  try {
    const subjects = await listMonitoredSubjects({
      portfolio: typeof portfolio === 'string' ? portfolio : undefined,
      status: typeof status === 'string' ? status : undefined,
    });
    res.json(subjects);
  } catch (error: any) {
    console.error('List monitored subjects error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/monitoring/subjects
 * Register a single customer into ongoing monitoring.
 */
monitoringRouter.post('/subjects', requireAuthOrScope('monitoring:write'), async (req, res): Promise<any> => {
  const { customerId, name, type, dob, country, nationality, portfolio } = req.body;
  const createdBy = (req as any).userEmail || 'system';

  try {
    const subject = await registerMonitoredSubject({
      customerId,
      name,
      type,
      dob,
      country,
      nationality,
      portfolio,
      createdBy,
    });
    res.status(201).json(subject);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/monitoring/subjects/batch
 * Bulk register multiple customers into ongoing monitoring.
 */
monitoringRouter.post('/subjects/batch', requireAuthOrScope('monitoring:write'), async (req, res): Promise<any> => {
  const { subjects } = req.body;
  const createdBy = (req as any).userEmail || 'system';

  if (!Array.isArray(subjects) || subjects.length === 0) {
    return res.status(400).json({ error: '"subjects" must be a non-empty array.' });
  }

  try {
    const input = subjects.map((s) => ({ ...s, createdBy }));
    const result = await batchRegisterMonitoredSubjects(input);
    res.status(201).json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/monitoring/subjects/:id
 * Delete a subject from monitoring portfolio.
 */
monitoringRouter.delete('/subjects/:id', requireAuthOrScope('monitoring:write'), async (req, res): Promise<any> => {
  try {
    const deleted = await deleteMonitoredSubject(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: `Monitored subject ${req.params.id} not found.` });
    }
    res.json({ message: 'Monitored subject deleted successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/monitoring/alerts
 * List monitoring screening alerts.
 */
monitoringRouter.get('/alerts', requireAuthOrScope('monitoring:read'), async (req, res): Promise<any> => {
  const { status, customerId } = req.query;
  try {
    const alerts = await listMonitoringAlerts({
      status: typeof status === 'string' ? (status as any) : undefined,
      customerId: typeof customerId === 'string' ? customerId : undefined,
    });
    res.json(alerts);
  } catch (error: any) {
    console.error('List monitoring alerts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/monitoring/alerts/:id/resolve
 * Resolve an alert and record the decision into Decision Memory.
 */
monitoringRouter.post('/alerts/:id/resolve', requireAuthOrScope('monitoring:write'), async (req, res): Promise<any> => {
  const { verdict, notes } = req.body;
  const resolvedBy = (req as any).userEmail || 'analyst';

  if (verdict !== 'false_positive' && verdict !== 'true_positive') {
    return res.status(400).json({ error: '"verdict" must be "false_positive" or "true_positive".' });
  }

  try {
    const alert = await resolveMonitoringAlert(req.params.id, {
      verdict,
      notes,
      resolvedBy,
    });
    res.json(alert);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/monitoring/run
 * Trigger an on-demand screening run for active customer portfolios.
 */
monitoringRouter.post('/run', requireAuthOrScope('monitoring:write'), async (req, res): Promise<any> => {
  const { portfolio } = req.body || {};
  try {
    const summary = await runPortfolioScreening(portfolio);
    res.json(summary);
  } catch (error: any) {
    console.error('Run screening error:', error);
    res.status(500).json({ error: error.message });
  }
});
