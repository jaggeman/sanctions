import * as admin from 'firebase-admin';
import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const projectId = process.env.FIREBASE_PROJECT_ID || 'paygap-jaggeman';

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
