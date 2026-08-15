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

export default db;
