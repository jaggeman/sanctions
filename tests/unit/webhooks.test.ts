import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebhookSubscription, WebhookEvent } from '../../src/shared/types';
import {
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  createWebhookPayload,
} from '../../src/webhooks';

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    subscriptions: new Map<string, WebhookSubscription>(),
    deliveries: [] as any[],
  };
  const fakeDb = {
    collection: vi.fn((name: string) => {
      if (name === 'webhookSubscriptions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const sub = state.subscriptions.get(id);
              return { exists: Boolean(sub), data: () => sub, id };
            }),
            set: vi.fn(async (data: any) => {
              state.subscriptions.set(id, data);
            }),
            delete: vi.fn(async () => {
              state.subscriptions.delete(id);
            }),
          })),
          get: vi.fn(async () => ({
            docs: Array.from(state.subscriptions.values()).map((s) => ({
              id: s.id,
              data: () => s,
            })),
          })),
        };
      }
      if (name === 'webhookDeliveries') {
        return {
          add: vi.fn(async (data: any) => {
            state.deliveries.push(data);
            return { id: `del_${Date.now()}` };
          }),
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

describe('Webhooks module (#318)', () => {
  beforeEach(() => {
    state.subscriptions.clear();
    state.deliveries = [];
    vi.clearAllMocks();
  });

  describe('Secrets and Signatures', () => {
    it('generates cryptographic secrets starting with whsec_', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    });

    it('generates valid HMAC-SHA256 signature and verifies successfully', () => {
      const secret = generateWebhookSecret();
      const payload = JSON.stringify({ event: 'decision.recorded', data: { entityId: 'EU-1' } });
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signWebhookPayload(payload, secret, timestamp);
      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

      const isValid = verifyWebhookSignature(payload, signature, secret);
      expect(isValid).toBe(true);
    });

    it('rejects tampered payload', () => {
      const secret = generateWebhookSecret();
      const payload = JSON.stringify({ event: 'decision.recorded', amount: 100 });
      const tampered = JSON.stringify({ event: 'decision.recorded', amount: 999 });
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signWebhookPayload(payload, secret, timestamp);
      const isValid = verifyWebhookSignature(tampered, signature, secret);
      expect(isValid).toBe(false);
    });

    it('rejects expired timestamp (replay attack prevention)', () => {
      const secret = generateWebhookSecret();
      const payload = JSON.stringify({ event: 'ping' });
      // 10 minutes ago (beyond 5 min tolerance)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;

      const signature = signWebhookPayload(payload, secret, oldTimestamp);
      const isValid = verifyWebhookSignature(payload, signature, secret, 300);
      expect(isValid).toBe(false);
    });

    it('rejects wrong secret', () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();
      const payload = JSON.stringify({ test: true });
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signWebhookPayload(payload, secret1, timestamp);
      const isValid = verifyWebhookSignature(payload, signature, secret2);
      expect(isValid).toBe(false);
    });
  });

  describe('createWebhookPayload', () => {
    it('creates standardized WebhookEvent object with unique ID and timestamp', () => {
      const event = createWebhookPayload('decision.recorded', {
        entityId: 'EU-100',
        subjectId: 'cust-123',
        verdict: 'false_positive',
      });

      expect(event.id).toMatch(/^evt_/);
      expect(event.type).toBe('decision.recorded');
      expect(event.createdAt).toBeDefined();
      expect(event.data.entityId).toBe('EU-100');
    });
  });
});
