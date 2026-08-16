import { describe, it, expect, afterAll, beforeEach } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) for issue #112 — proves append-only
 * history for decisions and overrides against a REAL Firestore emulator, not
 * a mock. Unit tests (tests/unit/decisions.test.ts, tests/unit/overrides.test.ts)
 * already cover this against a fake db; this file exists because a fake db
 * can't catch a real subcollection-write/orderBy-on-a-real-index bug.
 * Runs via `npm run test:integration`, which wraps this file in
 * `firebase emulators:exec --only firestore`.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { saveDecision, getDecisionHistory } = await import('../../src/decisions');
const { saveOverride, deleteOverride, getOverrideHistory } = await import('../../src/overrides');

async function clearCollections() {
  // recursiveDelete so the new history subcollections under decisions/overrides
  // docs don't leak between tests — Firestore never cascade-deletes them.
  for (const name of ['decisions', 'overrides']) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc: any) => db.recursiveDelete(doc.ref)));
  }
}

beforeEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await clearCollections();
});

describe('decisions — append-only history, real Firestore write path (issue #112)', () => {
  it('a second decision for the same entity+subject leaves the first verdict/timestamp/author/notes recoverable', async () => {
    const first = await saveDecision({
      entityId: 'EU-hist-1',
      subjectId: 'customer-1',
      verdict: 'true_positive',
      decidedBy: 'analyst-a@example.com',
      notes: 'Initial adjudication — strong name match.',
    });

    const second = await saveDecision({
      entityId: 'EU-hist-1',
      subjectId: 'customer-1',
      verdict: 'false_positive',
      decidedBy: 'analyst-b@example.com',
      notes: 'Overturned on review — different date of birth.',
    });

    const history = await getDecisionHistory('EU-hist-1', 'customer-1');
    expect(history).toHaveLength(2);

    // most recent first
    expect(history[0].changeType).toBe('replaced');
    expect(history[0].decision).toEqual(second);

    expect(history[1].changeType).toBe('created');
    expect(history[1].decision).toEqual(first);
    expect(history[1].decision.verdict).toBe('true_positive');
    expect(history[1].decision.decidedBy).toBe('analyst-a@example.com');
    expect(history[1].decision.notes).toBe('Initial adjudication — strong name match.');
  });
});

describe('overrides — append-only history, real Firestore write path (issue #112)', () => {
  it('a second override edit for the same entity leaves the first fields/reason/author recoverable', async () => {
    const first = await saveOverride(
      'EU-hist-2',
      { sanctionReason: 'First correction' },
      { overriddenBy: 'analyst-a@example.com', reason: 'Initial fix' },
    );

    const second = await saveOverride(
      'EU-hist-2',
      { sanctionReason: 'Second correction' },
      { overriddenBy: 'analyst-b@example.com', reason: 'Refined fix' },
    );

    const history = await getOverrideHistory('EU-hist-2');
    expect(history).toHaveLength(2);

    expect(history[0].changeType).toBe('replaced');
    expect(history[0].override).toEqual(second);

    expect(history[1].changeType).toBe('created');
    expect(history[1].override).toEqual(first);
    expect(history[1].override.fields.sanctionReason).toBe('First correction');
    expect(history[1].override.overriddenBy).toBe('analyst-a@example.com');
    expect(history[1].override.reason).toBe('Initial fix');
  });

  it('deleting an override leaves a durable record of who deleted it and when', async () => {
    const before = new Date().toISOString();

    const created = await saveOverride(
      'EU-hist-3',
      { sanctionReason: 'Temporary correction' },
      { overriddenBy: 'analyst-a@example.com', reason: 'Needs review' },
    );

    await deleteOverride('EU-hist-3', 'reviewer@example.com');

    // the current-state doc is gone...
    const currentSnap = await db.collection('overrides').doc('EU-hist-3').get();
    expect(currentSnap.exists).toBe(false);

    // ...but its history subcollection survives the parent doc's deletion.
    const history = await getOverrideHistory('EU-hist-3');
    expect(history).toHaveLength(2);

    expect(history[0].changeType).toBe('deleted');
    expect(history[0].changedBy).toBe('reviewer@example.com');
    expect(history[0].changedAt >= before).toBe(true);
    expect(history[0].override).toEqual(created);

    expect(history[1].changeType).toBe('created');
    expect(history[1].override).toEqual(created);
  });
});
