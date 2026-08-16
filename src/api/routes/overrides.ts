import { Router } from 'express';
import { db } from '../../shared/firebase';
import { saveOverride, deleteOverride, IMMUTABLE_KEYS } from '../../overrides';
import { invalidateSearchIndex } from '../../search';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';
import { validateEntityIdParam } from '../middleware/validateEntityIdParam';

export const overridesRouter = Router();

// Param callbacks are local to the router they're registered on — this
// router's own :id param needs its own copy (see src/api/index.ts's comment).
overridesRouter.param('id', validateEntityIdParam);

/**
 * GET /api/overrides/:id
 * Retrieve the active override for a record.
 */
overridesRouter.get('/:id', requireAuthOrScope('overrides:read'), async (req, res): Promise<any> => {
  try {
    const override = await db.collection('overrides').doc(req.params.id).get();
    if (!override.exists) {
      return res.status(404).json({ error: `No override found for record "${req.params.id}".` });
    }
    res.json(override.data());
  } catch (error: any) {
    console.error('Get override error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/overrides
 * List all active overrides.
 */
overridesRouter.get('/', requireAuthOrScope('overrides:read'), async (_req, res): Promise<any> => {
  try {
    const snapshot = await db.collection('overrides').get();
    const overrides = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    res.json(overrides);
  } catch (error: any) {
    console.error('List overrides error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/overrides/:id
 * Creates or replaces the override for a sanctions record (upsert). Requires
 * a non-empty "fields" object and a "reason". `overriddenBy` always comes
 * from the authenticated caller (req.userEmail, set by requireAuthOrScope
 * above) — never from the request body, which would let a caller attribute a
 * correction to someone else.
 */
overridesRouter.put('/:id', requireAuthOrScope('overrides:write'), async (req, res): Promise<any> => {
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/overrides/:id
 * Removes the override for a sanctions record, restoring exactly the
 * currently-imported values — the stored record itself was never touched.
 * Records who removed it in the override's own history (issue #112).
 */
overridesRouter.delete('/:id', requireAuthOrScope('overrides:write'), async (req, res): Promise<any> => {
  try {
    const deletedBy = (req as any).userEmail;
    await deleteOverride(req.params.id, deletedBy);
    // Awaited (issue #170) — same reasoning as the PUT handler above.
    await invalidateSearchIndex();
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Delete override error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
