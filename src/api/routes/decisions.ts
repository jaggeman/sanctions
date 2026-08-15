import { Router } from 'express';
import { saveDecision, listDecisionsForEntity } from '../../decisions';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';

export const decisionsRouter = Router();

/**
 * POST /api/decisions
 * Records (or overwrites) an analyst's false-positive/true-positive
 * adjudication for an entity+subject pair. `decidedBy` always comes from the
 * authenticated session, never the request body — a client-supplied
 * decidedBy would let anyone attribute an adjudication to a different
 * analyst (CLAUDE.md §6: never trust client-supplied identity). Requires
 * write access — there is no blanket app.use('/api', requireAuth) gate
 * (removed by issue #36); this router previously had no auth of its own.
 */
decisionsRouter.post('/', requireAuthOrScope('write'), async (req, res): Promise<any> => {
  const { entityId, subjectId, verdict, notes } = req.body;
  const decidedBy = (req as any).userEmail;

  try {
    const decision = await saveDecision({ entityId, subjectId, verdict, notes, decidedBy });
    res.status(201).json(decision);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/decisions/:entityId
 * Lists every recorded adjudication for an entity, across all subjects.
 * Requires read access (session or a read-scoped API token).
 */
decisionsRouter.get('/:entityId', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  try {
    const decisions = await listDecisionsForEntity(req.params.entityId);
    res.json(decisions);
  } catch (error: any) {
    console.error('List decisions error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
