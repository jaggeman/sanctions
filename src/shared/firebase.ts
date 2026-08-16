import * as admin from 'firebase-admin';
import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

// GCLOUD_PROJECT is auto-populated by the real Cloud Functions/Cloud Run
// runtime with the project this instance is actually deployed to — always
// correct there, no config needed. FIREBASE_PROJECT_ID exists only as a
// local-dev/.env override (it can't be set as a deployed function's env var
// at all: Firebase Functions v2 rejects any FIREBASE_-prefixed key at
// deploy time as reserved). Falling back to a hardcoded other project's id
// when neither is set silently pointed every deployment that forgot to
// configure this at the WRONG Firestore project — the service account for
// project A has no permission on project B's database, so every read/write
// failed with a generic PERMISSION_DENIED that looked like an IAM problem,
// not a "connected to the wrong project entirely" problem.
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'sanctions-app-dev-01';

// Initialize firebase admin if not already initialized
if (admin.apps.length === 0) {
  // If running with local emulator, firebase admin uses FIRESTORE_EMULATOR_HOST env variable
  admin.initializeApp({
    projectId: projectId,
  });
}

export const db = admin.firestore();
// Configure settings
db.settings({
  ignoreUndefinedProperties: true, // Crucial for Firestore to not throw on undefined fields
});

// Storage bucket for raw uploaded files (issue #7). Lazy rather than a
// top-level const: admin.storage().bucket() throws synchronously without an
// explicit bucket name (no default can be inferred from just a projectId),
// which broke every module importing this file, including ones that only
// ever need `db`. Deferring construction to first actual use means only
// upload-pipeline code (the only caller) pays that cost or that risk.
let bucketInstance: ReturnType<ReturnType<typeof admin.storage>['bucket']> | undefined;

export function getBucket() {
  if (!bucketInstance) {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;
    bucketInstance = admin.storage().bucket(bucketName);
  }
  return bucketInstance;
}

export default db;
