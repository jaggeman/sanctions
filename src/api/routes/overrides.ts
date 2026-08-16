import { Router } from 'express';
import { db } from '../../shared/firebase';
import { saveOverride, deleteOverride, IMMUTABLE_KEYS } from '../../overrides';
import { invalidateSearchIndex } from '../../search';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';
import { validateEntityIdParam } from '../middleware/validateEntityIdParam';

export const overridesRouter = Router();

// Both routes on this router are mutations (create/replace, delete) —
// require write access via a session or a write-scoped API token. There is
// no blanket app.use('/api', requireAuth) gate (removed by issue #36); a
// prior version of this comment claimed one still applied here, which was
// stale and meant this router was actually reachable unauthenticated.
overridesRouter.use(requireAuthOrScope('write'));

// Param callbacks are local to the router they're registered on — this
// router's own :id param needs its own copy (see src/api/index.ts's comment).
overridesRouter.param('id', validateEntityIdParam);

/**
 * PUT /api/overrides/:id
 * Creates or replaces the override for a sanctions record (upsert). Requires
 * a non-empty "fields" object and a "reason". `overriddenBy` always comes
 * from the authenticated caller (req.userEmail, set by requireAuthOrScope
 * above) — never from the request body, which would let a caller attribute a
 * correction to someone else.
 */
overridesRouter.put('/:id', async (req, res): Promise<any> => {
  const { id } = req.params;
  const { fields, reason } = req.body;

  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '"fields" must be a non-empty object of fields to override.' });
  }

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: '"reason" is required.' });
  }

  const blockedKeys = Object.keys(fields).filter((key) => IMMUTABLE_KEYS.has(key));
  if (blockedKeys.length > 0) {
    return res.status(400).json({ error: `These fields cannot be overridden: ${blockedKeys.join(', ')}.` });
  }

  try {
    const entityDoc = await db.collection('sanctions').doc(id).get();
    if (!entityDoc.exists) {
      return res.status(404).json({ error: `No sanctions record with id "${id}" — cannot override a record that doesn't exist.` });
    }

    const overriddenBy = (req as any).userEmail;
    const override = await saveOverride(id, fields, { overriddenBy, reason: reason.trim() });
    // Awaited (issue #170) — a client that reads-after-write (PUT then an
    // immediate search) must never observe stale cached data. Any failure
    // here is caught by this handler's own try/catch below, same as a
    // failure in saveOverride itself.
    await invalidateSearchIndex();

    res.json(override);
  } catch (error: any) {
    console.error('Save override error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * DELETE /api/overrides/:id
 * Removes the override for a sanctions record, restoring exactly the
 * currently-imported values — the stored record itself was never touched.
 * Records who removed it in the override's own history (issue #112).
 */
overridesRouter.delete('/:id', async (req, res): Promise<any> => {
  try {
    const deletedBy = (req as any).userEmail;
    await deleteOverride(req.params.id, deletedBy);
    // Awaited (issue #170) — same reasoning as the PUT handler above.
    await invalidateSearchIndex();
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Delete override error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
