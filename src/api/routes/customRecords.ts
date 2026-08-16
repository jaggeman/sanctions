import { Router } from 'express';
import { createCustomRecord, updateCustomRecord, deleteCustomRecord, getCustomRecord } from '../../customRecords';
import { requireAdmin } from '../middleware/requireAdmin';
import { validateEntityIdParam } from '../middleware/validateEntityIdParam';
import { isValidEntityId } from '../../shared/entityId';

export const customRecordsRouter = Router();

// Internal watchlist entries bypass every official source's own validation
// and provenance — admin-only, per issue #172's own recommendation.
customRecordsRouter.use(requireAdmin);

// Param callbacks are local to the router they're registered on — this
// router's own :id param needs its own copy (see validateEntityIdParam.ts).
customRecordsRouter.param('id', validateEntityIdParam);

/**
 * POST /api/admin/custom-records
 * Creates a source: 'CUSTOM' record — an internal watchlist entry or local
 * PEP the official lists don't cover.
 */
customRecordsRouter.post('/', async (req, res): Promise<any> => {
  const { id, type, primaryName } = req.body || {};

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: '"id" is required.' });
  }
  // Not a route param on this verb (there's no :id in POST /), so it needs
  // its own check here rather than relying on the router's .param('id', ...)
  // — a "/" in a body field bypasses that entirely.
  if (!isValidEntityId(id)) {
    return res.status(400).json({ error: `Invalid id "${id}" — must contain only letters, numbers, hyphens, and underscores.` });
  }
  if (!type || typeof type !== 'string') {
    return res.status(400).json({ error: '"type" is required.' });
  }
  if (!primaryName || typeof primaryName !== 'string' || !primaryName.trim()) {
    return res.status(400).json({ error: '"primaryName" is required.' });
  }

  try {
    const record = await createCustomRecord(req.body);
    res.status(201).json(record);
  } catch (error: any) {
    if (/already exists/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Create custom record error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * PUT /api/admin/custom-records/:id
 * Patches an existing custom record. Refuses to touch a non-CUSTOM record
 * (see src/customRecords/index.ts) — use the overrides path for those.
 */
customRecordsRouter.put('/:id', async (req, res): Promise<any> => {
  try {
    const record = await updateCustomRecord(req.params.id, req.body || {});
    res.json(record);
  } catch (error: any) {
    if (/no custom record/i.test(error.message)) {
      return res.status(404).json({ error: error.message });
    }
    if (/not a custom record/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Update custom record error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * DELETE /api/admin/custom-records/:id
 * Requires an explicit {confirm: true} body, matching
 * src/customRecords/index.ts's own guard against an accidental delete.
 */
customRecordsRouter.delete('/:id', async (req, res): Promise<any> => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Deleting a custom record requires explicit confirm: true in the request body.' });
  }

  try {
    await deleteCustomRecord(req.params.id, { confirm: true });
    res.json({ ok: true });
  } catch (error: any) {
    if (/no custom record/i.test(error.message)) {
      return res.status(404).json({ error: error.message });
    }
    if (/not a custom record/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Delete custom record error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/admin/custom-records/:id
 */
customRecordsRouter.get('/:id', async (req, res): Promise<any> => {
  try {
    const record = await getCustomRecord(req.params.id);
    if (!record) {
      return res.status(404).json({ error: `No custom record found with id "${req.params.id}".` });
    }
    res.json(record);
  } catch (error: any) {
    console.error('Get custom record error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
