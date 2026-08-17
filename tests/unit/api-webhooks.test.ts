import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

const {
  mockSaveWebhookSubscription,
  mockListWebhookSubscriptions,
  mockGetWebhookSubscription,
  mockDeleteWebhookSubscription,
  mockSendTestPing,
} = vi.hoisted(() => ({
  mockSaveWebhookSubscription: vi.fn(),
  mockListWebhookSubscriptions: vi.fn(),
  mockGetWebhookSubscription: vi.fn(),
  mockDeleteWebhookSubscription: vi.fn(),
  mockSendTestPing: vi.fn(),
}));

vi.mock('../../src/webhooks', () => ({
  saveWebhookSubscription: mockSaveWebhookSubscription,
  listWebhookSubscriptions: mockListWebhookSubscriptions,
  getWebhookSubscription: mockGetWebhookSubscription,
  deleteWebhookSubscription: mockDeleteWebhookSubscription,
  sendTestPing: mockSendTestPing,
}));

// Mock requireAuthOrScope middleware to simulate authenticated user
vi.mock('../../src/api/middleware/requireAuthOrScope', () => ({
  requireAuthOrScope: () => (req: any, _res: any, next: any) => {
    req.userEmail = 'admin@example.com';
    req.authMethod = 'session';
    next();
  },
}));

const { webhooksRouter } = await import('../../src/api/routes/webhooks');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/webhooks', webhooksRouter);
  return app;
}

describe('API Routes: Webhooks (/api/webhooks)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/webhooks lists all subscriptions', async () => {
    mockListWebhookSubscriptions.mockResolvedValue([
      { id: 'whsub_1', url: 'https://example.com/webhook', events: ['decision.recorded'], active: true },
    ]);

    const res = await request(buildApp()).get('/api/webhooks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('whsub_1');
  });

  it('POST /api/webhooks creates a new subscription', async () => {
    mockSaveWebhookSubscription.mockResolvedValue({
      id: 'whsub_123',
      url: 'https://example.com/events',
      secret: 'whsec_abcdef',
      events: ['decision.recorded'],
      active: true,
      createdBy: 'admin@example.com',
    });

    const res = await request(buildApp())
      .post('/api/webhooks')
      .send({ url: 'https://example.com/events', events: ['decision.recorded'] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('whsub_123');
    expect(mockSaveWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/events', createdBy: 'admin@example.com' }),
    );
  });

  it('POST /api/webhooks returns 400 on invalid input', async () => {
    mockSaveWebhookSubscription.mockRejectedValue(new Error('"url" is required.'));

    const res = await request(buildApp()).post('/api/webhooks').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"url" is required.');
  });

  it('GET /api/webhooks/:id returns 404 if not found', async () => {
    mockGetWebhookSubscription.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/webhooks/whsub_nonexistent');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/webhooks/:id deletes subscription', async () => {
    mockDeleteWebhookSubscription.mockResolvedValue(true);

    const res = await request(buildApp()).delete('/api/webhooks/whsub_123');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('deleted successfully');
  });

  it('POST /api/webhooks/:id/test triggers test ping', async () => {
    mockSendTestPing.mockResolvedValue({
      id: 'del_1',
      subscriptionId: 'whsub_123',
      success: true,
      statusCode: 200,
    });

    const res = await request(buildApp()).post('/api/webhooks/whsub_123/test');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
