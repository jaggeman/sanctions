import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

/**
 * Rules layer (CLAUDE.md §1) — these tests run against a real Firestore
 * emulator (via `npm run test:rules`, which wraps them in
 * `firebase emulators:exec`), not a mock. That's the point: firestore.rules is
 * config, not code the app's own test doubles ever exercise.
 *
 * Context: the app's ONLY read/write path today is the Express API in
 * src/api/index.ts, which uses firebase-admin — the Admin SDK always bypasses
 * security rules entirely, with or without this file. Nothing in
 * frontend/src (verified: no `firebase/firestore` import anywhere) ever talks
 * to Firestore directly. So these rules exist purely as a defense-in-depth
 * backstop for direct client-SDK access — e.g. if a project config/API key
 * ever leaked, or a future feature adds client-side reads. Least privilege
 * (§6) for that backstop, given there is no auth system in this app at all,
 * is to deny direct client access outright and force every path through the
 * validated server API.
 */

const RULES_PATH = path.resolve(__dirname, '../../firestore.rules');
const PROJECT_ID = 'sanctions-rules-test';

let testEnv: RulesTestEnvironment;

const SAMPLE_RECORD = {
  id: 'PEP-1',
  source: 'PEP',
  type: 'individual',
  primaryName: 'Test Person',
  aliases: [],
  searchNames: ['test', 'person'],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf-8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('firestore.rules — direct client access to the sanctions collection', () => {
  it('denies an unauthenticated client reading a document', async () => {
    // Seed the document with admin privileges (bypasses rules), then attempt
    // to read it back as an ordinary unauthenticated client.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('sanctions').doc('PEP-1').set(SAMPLE_RECORD);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('sanctions').doc('PEP-1').get());
  });

  it('denies an unauthenticated client listing/querying the collection', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('sanctions').doc('PEP-1').set(SAMPLE_RECORD);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('sanctions').get());
  });

  it('denies an unauthenticated client creating a document', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('sanctions').doc('PEP-2').set(SAMPLE_RECORD));
  });

  it('denies an unauthenticated client deleting a document', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('sanctions').doc('PEP-1').set(SAMPLE_RECORD);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('sanctions').doc('PEP-1').delete());
  });

  it('denies even an authenticated client — this app has no auth system, so no token should grant access', async () => {
    // Simulates the scenario the checklist warns about: a client holding *some*
    // token (e.g. a leaked/misused credential) must not be treated as
    // privileged just because request.auth is non-null.
    const authedDb = testEnv.authenticatedContext('some-user-id').firestore();
    await assertFails(authedDb.collection('sanctions').doc('PEP-3').set(SAMPLE_RECORD));
    await assertFails(authedDb.collection('sanctions').doc('PEP-3').get());
  });

  it('still allows the trusted server path (Admin SDK) to read and write freely', async () => {
    // withSecurityRulesDisabled emulates the Admin SDK context the real
    // Express API runs under (firebase-admin never evaluates rules). If this
    // ever failed, it would mean the app's actual import/search pipeline broke,
    // not a rules problem.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.firestore().collection('sanctions').doc('PEP-4').set(SAMPLE_RECORD));
      await assertSucceeds(ctx.firestore().collection('sanctions').doc('PEP-4').get());
    });
  });

  it('denies access to an arbitrary, unrelated collection too (the deny-all is a database-wide backstop)', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('anything_else').doc('x').set({ a: 1 }));
    await assertFails(unauthedDb.collection('anything_else').doc('x').get());
  });
});

describe('firestore.rules — the "versions" subcollection (issue #9)', () => {
  // sanctions/{id}/versions/{importId} is written only by the trusted server
  // path (uploadRecords/delistRecords via the Admin SDK). No client should
  // ever be able to read or write a version entry directly — that would let a
  // client forge or read the audit trail. Already covered by the blanket
  // deny-all above; made explicit here because the issue's acceptance
  // criteria call it out by name.
  const SAMPLE_VERSION = {
    importId: 'import-1',
    changedAt: '2024-01-01T00:00:00.000Z',
    changeType: 'created',
    record: SAMPLE_RECORD,
  };

  it('denies an unauthenticated client reading a version entry', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .firestore()
        .collection('sanctions')
        .doc('PEP-1')
        .collection('versions')
        .doc('import-1')
        .set(SAMPLE_VERSION);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      unauthedDb.collection('sanctions').doc('PEP-1').collection('versions').doc('import-1').get(),
    );
  });

  it('denies an unauthenticated client writing a version entry', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      unauthedDb.collection('sanctions').doc('PEP-1').collection('versions').doc('import-1').set(SAMPLE_VERSION),
    );
  });

  it('still allows the trusted server path (Admin SDK) to read and write version entries freely', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().collection('sanctions').doc('PEP-1').collection('versions').doc('import-1');
      await assertSucceeds(ref.set(SAMPLE_VERSION));
      await assertSucceeds(ref.get());
    });
  });
});
