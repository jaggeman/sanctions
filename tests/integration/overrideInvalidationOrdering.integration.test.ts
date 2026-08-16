import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

/**
 * Integration layer (CLAUDE.md §1) for issue #170 — proves the ordering fix
 * against a REAL Firestore emulator, not a mock. tests/unit/overridesRoutes.test.ts
 * already proves the handler awaits a controlled promise, but that mock
 * never touches real Firestore, so it can't prove `invalidateSearchIndex`'s
 * actual write still happens correctly on this path.
 *
 * A raw wall-clock race (call PUT, then immediately re-read
 * meta/searchIndex.version with no wait) was tried first and discarded: once
 * the emulator's gRPC channel warms up within a test process, the real write
 * frequently completes faster than Express's own response path, making an
 * un-awaited bug intermittently pass anyway — a flaky regression gate is
 * worse than no gate. Instead, invalidateSearchIndex is spied so the REAL
 * underlying Firestore write still happens (verified via the version
 * assertions below), but resolution is delayed by a fixed amount — turning
 * an environment-dependent race into a deterministic ordering check, exactly
 * like the unit test's technique, while still exercising the real write path
 * the unit test's full mock cannot.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('../../src/search', async () => {
  const actual = await vi.importActual<typeof import('../../src/search')>('../../src/search');
  return {
    ...actual,
    invalidateSearchIndex: async () => {
      await actual.invalidateSearchIndex(); // the real Firestore write
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('invalidated');
    },
  };
});

const { db } = await import('../../src/shared/firebase');
const { overridesRouter } = await import('../../src/api/routes/overrides');
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');

const CALLER_EMAIL = 'analyst@example.com';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/overrides', overridesRouter);
  return app;
}

async function authedCookie(email: string = CALLER_EMAIL) {
  return `${SESSION_COOKIE_NAME}=${await createSession(email)}`;
}

async function searchIndexVersion(): Promise<number> {
  const snap = await db.collection('meta').doc('searchIndex').get();
  const version = snap.exists ? snap.data()?.version : undefined;
  return typeof version === 'number' ? version : 0;
}

async function clearCollections() {
  for (const name of ['sanctions', 'overrides', 'sessions', 'meta']) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc: any) => db.recursiveDelete(doc.ref)));
  }
}

beforeEach(async () => {
  order.length = 0;
  await clearCollections();
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
  await db.collection('sanctions').doc('EU-inv-1').set({
    id: 'EU-inv-1',
    source: 'EU',
    type: 'individual',
    primaryName: 'Original Name',
    aliases: [],
    searchNames: [],
    sanctionReason: 'Original reason',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
});

afterAll(async () => {
  await clearCollections();
});

describe('invalidateSearchIndex ordering against a real Firestore emulator (issue #170)', () => {
  it('PUT /api/overrides/:id — waits for the real invalidation write before responding', async () => {
    const before = await searchIndexVersion();

    const res = await request(buildApp())
      .put('/api/overrides/EU-inv-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Analyst-corrected reason' }, reason: 'Fix' });
    order.push('responded');

    expect(res.status).toBe(200);
    expect(order).toEqual(['invalidated', 'responded']);
    // Proves this wasn't just a mock agreeing with itself — the real
    // Firestore counter genuinely incremented.
    expect(await searchIndexVersion()).toBe(before + 1);
  });

  it('DELETE /api/overrides/:id — waits for the real invalidation write before responding', async () => {
    await request(buildApp())
      .put('/api/overrides/EU-inv-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Analyst-corrected reason' }, reason: 'Fix' });
    order.length = 0;

    const before = await searchIndexVersion();

    const res = await request(buildApp()).delete('/api/overrides/EU-inv-1').set('Cookie', await authedCookie());
    order.push('responded');

    expect(res.status).toBe(200);
    expect(order).toEqual(['invalidated', 'responded']);
    expect(await searchIndexVersion()).toBe(before + 1);
  });
});
