import { Router } from 'express';
import { createApiToken, listApiTokens, revokeApiToken, validateScopes } from '../../shared/apiTokens';
import { requireAdmin } from '../middleware/requireAdmin';
import { validateEntityIdParam } from '../middleware/validateEntityIdParam';

export const tokensRouter = Router();

tokensRouter.use(requireAdmin);

// Param callbacks are local to the router they're registered on — this
// router's own :id param (POST /:id/revoke) needs its own copy.
tokensRouter.param('id', validateEntityIdParam);

/**
 * POST /api/admin/tokens
 * Create a new API token. The raw token is only ever returned here —
 * only its hash is persisted.
 */
tokensRouter.post('/', async (req, res): Promise<any> => {
  const { name, scopes } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '"name" is required.' });
  }

  if (!validateScopes(scopes)) {
    return res.status(400).json({ error: '"scopes" must be a non-empty array of "read" and/or "write".' });
  }

  try {
    const { token, record } = await createApiToken(name.trim(), scopes);
    res.status(201).json({ token, ...record });
  } catch (error: any) {
    console.error('Create token error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/admin/tokens
 * List all tokens (hash never included).
 */
tokensRouter.get('/', async (_req, res): Promise<any> => {
  try {
    const tokens = await listApiTokens();
    res.json(tokens);
  } catch (error: any) {
    console.error('List tokens error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/admin/tokens/:id/revoke
 * Revoke a token. Revoked tokens are kept (not deleted) for audit history.
 */
tokensRouter.post('/:id/revoke', async (req, res): Promise<any> => {
  try {
    const record = await revokeApiToken(req.params.id);
    if (!record) {
      return res.status(404).json({ error: `Token ${req.params.id} not found.` });
    }
    res.json(record);
  } catch (error: any) {
    console.error('Revoke token error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
