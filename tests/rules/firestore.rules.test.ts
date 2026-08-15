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

/**
 * `firebase emulators:exec` exports FIRESTORE_EMULATOR_HOST with whatever port
 * firebase.json actually resolved to. Reading it here rather than hardcoding
 * 8080 is what lets this suite run when another session on the same machine
 * already holds the default port (CLAUDE.md §1 — one emulator per session).
 */
function emulatorAddress(): { host: string; port: number } {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) return { host: '127.0.0.1', port: 8080 };
  const separator = raw.lastIndexOf(':');
  const host = raw.slice(0, separator) || '127.0.0.1';
  const port = Number(raw.slice(separator + 1));
  return { host: host === 'localhost' ? '127.0.0.1' : host, port };
}

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
      ...emulatorAddress(),
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

// Issue #10 acceptance criterion: "Rules tests: overrides are authenticated-write
// only, never client-writable anonymously" — already covered by the blanket
// deny-all backstop above, but the criterion names the collection explicitly,
// so it gets its own explicit proof rather than relying solely on the generic
// "anything_else" case.
describe('firestore.rules — overrides/{entityId} collection (issue #10)', () => {
  const SAMPLE_OVERRIDE = {
    entityId: 'EU-1',
    fields: { sanctionReason: 'Corrected reason' },
    overriddenBy: 'analyst@example.com',
    overriddenAt: '2026-08-15T00:00:00.000Z',
    reason: 'Corrected transliteration',
  };

  it('denies an unauthenticated client writing an override', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('overrides').doc('EU-1').set(SAMPLE_OVERRIDE));
  });

  it('denies an unauthenticated client reading an override', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('overrides').doc('EU-1').set(SAMPLE_OVERRIDE);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('overrides').doc('EU-1').get());
  });

  it('denies even an authenticated client — no token is privileged without a real auth system', async () => {
    const authedDb = testEnv.authenticatedContext('some-user-id').firestore();
    await assertFails(authedDb.collection('overrides').doc('EU-1').set(SAMPLE_OVERRIDE));
  });

  it('still allows the trusted server path (Admin SDK) to read and write overrides freely', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.firestore().collection('overrides').doc('EU-1').set(SAMPLE_OVERRIDE));
      await assertSucceeds(ctx.firestore().collection('overrides').doc('EU-1').get());
    });
  });
});

// Issue #7 acceptance criterion: "Rules tests: a client cannot write to
// `imports` directly" — already covered by the blanket deny-all backstop
// above, but named explicitly in the acceptance criteria, so it gets its own
// proof rather than relying solely on the generic "anything_else" case.
describe('firestore.rules — imports/{importId} collection (issue #7)', () => {
  const SAMPLE_IMPORT = {
    importId: 'abc123',
    filename: 'test.csv',
    sha256: 'abc123',
    sizeBytes: 1024,
    storagePath: 'imports/abc123/test.csv',
    source: 'PEP',
    format: 'csv',
    fileGenerationDate: null,
    uploadedBy: 'user@example.com',
    uploadedAt: '2026-08-15T00:00:00.000Z',
    status: 'applied',
  };

  it('denies an unauthenticated client writing an import record', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('imports').doc('abc123').set(SAMPLE_IMPORT));
  });

  it('denies an unauthenticated client reading an import record', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('imports').doc('abc123').set(SAMPLE_IMPORT);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('imports').doc('abc123').get());
  });

  it('denies even an authenticated client — no token is privileged without a real auth system', async () => {
    const authedDb = testEnv.authenticatedContext('some-user-id').firestore();
    await assertFails(authedDb.collection('imports').doc('abc123').set(SAMPLE_IMPORT));
  });

  it('still allows the trusted server path (Admin SDK) to read and write imports freely', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.firestore().collection('imports').doc('abc123').set(SAMPLE_IMPORT));
      await assertSucceeds(ctx.firestore().collection('imports').doc('abc123').get());
    });
  });
});

// Issue #22 acceptance criterion: "Firestore rules test for the new
// collection (mirror the overrides block)" — already covered by the blanket
// deny-all backstop above, but named explicitly, so it gets its own proof
// rather than relying solely on the generic "anything_else" case.
describe('firestore.rules — decisions/{entityId__subjectId} collection (issue #22)', () => {
  const SAMPLE_DECISION = {
    entityId: 'EU-1',
    subjectId: 'customer-acme',
    verdict: 'false_positive',
    decidedBy: 'analyst@example.com',
    decidedAt: '2026-08-15T00:00:00.000Z',
  };

  it('denies an unauthenticated client writing a decision', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('decisions').doc('EU-1__customer-acme').set(SAMPLE_DECISION));
  });

  it('denies an unauthenticated client reading a decision', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('decisions').doc('EU-1__customer-acme').set(SAMPLE_DECISION);
    });

    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthedDb.collection('decisions').doc('EU-1__customer-acme').get());
  });

  it('denies even an authenticated client — no token is privileged without a real auth system', async () => {
    const authedDb = testEnv.authenticatedContext('some-user-id').firestore();
    await assertFails(authedDb.collection('decisions').doc('EU-1__customer-acme').set(SAMPLE_DECISION));
  });

  it('still allows the trusted server path (Admin SDK) to read and write decisions freely', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.firestore().collection('decisions').doc('EU-1__customer-acme').set(SAMPLE_DECISION));
      await assertSucceeds(ctx.firestore().collection('decisions').doc('EU-1__customer-acme').get());
    });
  });
});
