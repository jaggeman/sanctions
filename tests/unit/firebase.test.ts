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
});

describe('getBucket', () => {
  it('builds the bucket name from FIREBASE_PROJECT_ID by default', async () => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    const { getBucket } = await import('../../src/shared/firebase');

    getBucket();

    expect(mockBucket).toHaveBeenCalledWith('my-project.appspot.com');
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
