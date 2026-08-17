/**
 * Webhooks Management and Dispatch Engine (Issue #318).
 *
 * Provides HMAC-SHA256 signed event delivery to customer webhook endpoints
 * with signature verification and replay-attack protection.
 */

import * as crypto from 'crypto';
import { db } from '../shared/firebase';
import { logger } from '../shared/logger';
import {
  WebhookSubscription,
  WebhookEvent,
  WebhookEventType,
  WebhookDeliveryAttempt,
} from '../shared/types';

const log = logger.child({ module: 'webhooks' });
const SUBSCRIPTIONS_COLLECTION = 'webhookSubscriptions';
const DELIVERIES_COLLECTION = 'webhookDeliveries';

export const ALL_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  'decision.recorded',
  'alert.created',
  'import.completed',
  'ping',
];

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

export function generateWebhookId(): string {
  return `whsub_${crypto.randomBytes(12).toString('hex')}`;
}

export function generateEventId(): string {
  return `evt_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Creates a signed payload header using HMAC-SHA256.
 * Format: `t=<timestamp>,v1=<signature>`
 */
export function signWebhookPayload(payload: string, secret: string, timestamp: number): string {
  const signedData = `${timestamp}.${payload}`;
  const hmac = crypto.createHmac('sha256', secret).update(signedData).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Verifies an incoming webhook signature header against secret and payload.
 * Guards against timing attacks using crypto.timingSafeEqual and protects
 * against replay attacks using toleranceSeconds (default 300s / 5min).
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(',');
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key === 't') timestamp = parseInt(val, 10);
    if (key === 'v1') signature = val;
  }

  if (timestamp === null || Number.isNaN(timestamp) || !signature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false; // Expired signature / potential replay attack
  }

  const expectedSignedData = `${timestamp}.${payload}`;
  const expectedHmac = crypto.createHmac('sha256', secret).update(expectedSignedData).digest('hex');

  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedHmac, 'hex');
    if (signatureBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function createWebhookPayload<T>(type: WebhookEventType, data: T): WebhookEvent<T> {
  return {
    id: generateEventId(),
    type,
    createdAt: new Date().toISOString(),
    data,
  };
}

export interface CreateWebhookSubscriptionInput {
  url: string;
  events?: WebhookEventType[];
  description?: string;
  createdBy: string;
  secret?: string;
  active?: boolean;
}

export async function saveWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
): Promise<WebhookSubscription> {
  if (!input.url || typeof input.url !== 'string') {
    throw new Error('"url" is required.');
  }

  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('URL must use http or https protocol.');
    }
  } catch (err: any) {
    throw new Error(`Invalid webhook URL: ${err.message}`);
  }

  const id = generateWebhookId();
  const secret = input.secret || generateWebhookSecret();
  const events = (input.events && input.events.length > 0)
    ? input.events
    : ['decision.recorded', 'alert.created', 'import.completed'];

  const subscription: WebhookSubscription = {
    id,
    url: input.url.trim(),
    secret,
    events: events as WebhookEventType[],
    description: input.description?.trim() || undefined,
    active: input.active !== false,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).set(subscription);
  log.info('webhook.subscription_created', { id, url: subscription.url, events: subscription.events });
  return subscription;
}

export async function getWebhookSubscription(id: string): Promise<WebhookSubscription | null> {
  const doc = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return doc.data() as WebhookSubscription;
}

export async function listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
  const snapshot = await db.collection(SUBSCRIPTIONS_COLLECTION).get();
  const subs: WebhookSubscription[] = [];
  snapshot.forEach((doc: any) => {
    subs.push(doc.data() as WebhookSubscription);
  });
  return subs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteWebhookSubscription(id: string): Promise<boolean> {
  const docRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return false;
  await docRef.delete();
  log.info('webhook.subscription_deleted', { id });
  return true;
}

/**
 * Delivers a single signed payload to a specific webhook subscription.
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  event: WebhookEvent,
): Promise<WebhookDeliveryAttempt> {
  const startedAt = Date.now();
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(payload, subscription.secret, timestamp);

  const attemptId = `del_${crypto.randomBytes(12).toString('hex')}`;
  let statusCode: number | undefined;
  let success = false;
  let errorMessage: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SanctionsChecker-Webhook/1.0',
        'X-Sanctions-Event': event.type,
        'X-Sanctions-Delivery': attemptId,
        'X-Sanctions-Signature': signature,
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    statusCode = response.status;
    success = response.ok;
    if (!response.ok) {
      errorMessage = `HTTP error ${response.status} ${response.statusText}`;
    }
  } catch (err: any) {
    success = false;
    errorMessage = err.name === 'AbortError' ? 'Delivery timed out after 10000ms' : err.message;
  }

  const durationMs = Date.now() - startedAt;
  const attempt: WebhookDeliveryAttempt = {
    id: attemptId,
    subscriptionId: subscription.id,
    eventId: event.id,
    eventType: event.type,
    url: subscription.url,
    statusCode,
    success,
    error: errorMessage,
    attemptedAt: new Date().toISOString(),
    durationMs,
  };

  // Record delivery audit
  try {
    await db.collection(DELIVERIES_COLLECTION).add(attempt);
  } catch (err: any) {
    log.error('webhook.delivery_log_failed', { attemptId, error: err.message });
  }

  return attempt;
}

/**
 * Dispatches an event to all active matching webhook subscriptions.
 * Runs asynchronously without blocking the primary business transaction.
 */
export async function dispatchWebhookEvent(eventType: WebhookEventType, data: any): Promise<void> {
  try {
    const event = createWebhookPayload(eventType, data);
    const subscriptions = await listWebhookSubscriptions();
    const activeMatching = subscriptions.filter(
      (s) => s.active && (s.events.includes(eventType) || s.events.includes('*' as any)),
    );

    if (activeMatching.length === 0) return;

    log.info('webhook.dispatching', { eventType, count: activeMatching.length });

    // Fire all delivery attempts concurrently
    await Promise.allSettled(
      activeMatching.map((sub) => deliverWebhook(sub, event)),
    );
  } catch (err: any) {
    log.error('webhook.dispatch_failed', { eventType, error: err.message });
  }
}

/**
 * Sends an immediate test ping event to verify a subscription endpoint.
 */
export async function sendTestPing(subscriptionId: string): Promise<WebhookDeliveryAttempt> {
  const sub = await getWebhookSubscription(subscriptionId);
  if (!sub) throw new Error(`Webhook subscription ${subscriptionId} not found.`);

  const testEvent = createWebhookPayload('ping', {
    message: 'Test ping from SanctionsChecker webhook service',
    subscriptionId: sub.id,
    timestamp: new Date().toISOString(),
  });

  return deliverWebhook(sub, testEvent);
}
