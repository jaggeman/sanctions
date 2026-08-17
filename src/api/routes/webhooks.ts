import { Router } from 'express';
import {
  saveWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  deleteWebhookSubscription,
  sendTestPing,
} from '../../webhooks';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';

export const webhooksRouter = Router();

/**
 * GET /api/webhooks
 * List all webhook subscriptions.
 */
webhooksRouter.get('/', requireAuthOrScope('webhooks:read'), async (_req, res): Promise<any> => {
  try {
    const subs = await listWebhookSubscriptions();
    res.json(subs);
  } catch (error: any) {
    console.error('List webhooks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/webhooks
 * Create a new webhook subscription.
 */
webhooksRouter.post('/', requireAuthOrScope('webhooks:write'), async (req, res): Promise<any> => {
  const { url, events, description, secret } = req.body;
  const createdBy = (req as any).userEmail || 'system';

  try {
    const sub = await saveWebhookSubscription({
      url,
      events,
      description,
      secret,
      createdBy,
    });
    res.status(201).json(sub);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/webhooks/:id
 * Get details for a single webhook subscription.
 */
webhooksRouter.get('/:id', requireAuthOrScope('webhooks:read'), async (req, res): Promise<any> => {
  try {
    const sub = await getWebhookSubscription(req.params.id);
    if (!sub) {
      return res.status(404).json({ error: `Webhook subscription ${req.params.id} not found.` });
    }
    res.json(sub);
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook subscription.
 */
webhooksRouter.delete('/:id', requireAuthOrScope('webhooks:write'), async (req, res): Promise<any> => {
  try {
    const deleted = await deleteWebhookSubscription(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: `Webhook subscription ${req.params.id} not found.` });
    }
    res.json({ message: 'Webhook subscription deleted successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/webhooks/:id/test
 * Sends a test ping to verify the webhook destination URL.
 */
webhooksRouter.post('/:id/test', requireAuthOrScope('webhooks:write'), async (req, res): Promise<any> => {
  try {
    const attempt = await sendTestPing(req.params.id);
    res.json(attempt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});
