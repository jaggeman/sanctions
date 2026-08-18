import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #75: getBucket() (src/shared/firebase.ts) has 0% function coverage —
// nothing in the suite ever calls it. firebase-admin is mocked entirely so
// this stays a fast, offline unit test; module state (the lazy bucketInstance
// singleton) is reset via vi.resetModules() + a fresh dynamic import per
// test, since admin init runs once at module load.
const mockBucket = vi.fn((name: string) => ({ name }));
const mockStorage = vi.fn(() => ({ bucket: mockBucket }));
const mockFirestoreSettings = vi.fn();
const mockFirestore = vi.fn(() => ({ settings: mockFirestoreSettings }));
const mockInitializeApp = vi.fn();

vi.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: mockInitializeApp,
  firestore: mockFirestore,
  storage: mockStorage,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  mockBucket.mockClear();
  mockStorage.mockClear();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.FIREBASE_STORAGE_BUCKET;
  // GCLOUD_PROJECT is real ambient state here, not test pollution: `firebase
  // emulators:exec` (which `npm test` wraps this suite in) sets it itself to
  // the project in .firebaserc, so it is already present in ORIGINAL_ENV
  // before any test runs. Each test that wants it sets it explicitly; the
  // rest must not silently inherit it from the real environment.
  delete process.env.GCLOUD_PROJECT;
});

describe('getBucket', () => {
  it('builds the bucket name from FIREBASE_PROJECT_ID by default', async () => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    const { getBucket } = await import('../../src/shared/firebase');

    getBucket();

    expect(mockBucket).toHaveBeenCalledWith('my-project-uploads');
  });

  it('prefers GCLOUD_PROJECT (the real deployed project) over FIREBASE_PROJECT_ID or the hardcoded fallback', async () => {
    // A real incident: this deployment's env only had GCLOUD_PROJECT set
    // (auto-populated by Cloud Functions), not FIREBASE_PROJECT_ID (which
    // can't even be set as a deployed function's env var — Firebase
    // Functions v2 rejects any FIREBASE_-prefixed key at deploy time). The
    // old fallback-to-a-hardcoded-other-project's-id silently pointed every
    // such deployment at the wrong Firestore project.
    process.env.GCLOUD_PROJECT = 'sanctions-app-dev-01';
    process.env.FIREBASE_PROJECT_ID = 'some-other-project';
    const { getBucket } = await import('../../src/shared/firebase');

    getBucket();

    expect(mockBucket).toHaveBeenCalledWith('sanctions-app-dev-01-uploads');
  });

  it('uses FIREBASE_STORAGE_BUCKET when explicitly set, instead of the derived default', async () => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    process.env.FIREBASE_STORAGE_BUCKET = 'custom-bucket-name';
    const { getBucket } = await import('../../src/shared/firebase');

    getBucket();

    expect(mockBucket).toHaveBeenCalledWith('custom-bucket-name');
  });

  it('memoizes the bucket — only constructs it once across repeated calls', async () => {
    const { getBucket } = await import('../../src/shared/firebase');

    const first = getBucket();
    const second = getBucket();

    expect(first).toBe(second);
    expect(mockStorage).toHaveBeenCalledTimes(1);
    expect(mockBucket).toHaveBeenCalledTimes(1);
  });
});
