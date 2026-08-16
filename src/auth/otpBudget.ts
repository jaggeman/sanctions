import { db } from '../shared/firebase';
import { OTP_GLOBAL_SEND_LIMIT, OTP_GLOBAL_SEND_WINDOW_MS } from './otp';

const COLLECTION = 'otpGlobalBudget';

/**
 * Fixed-window bucket id — every send within the same window shares one
 * counter doc. Simple, and sufficient for an abuse brake rather than a
 * precision guarantee: a burst can land right at a window boundary (up to
 * ~2x the limit across the seam). Accepted trade-off; a sliding-window or
 * token-bucket scheme would close that gap at real implementation cost this
 * issue doesn't call for.
 */
function currentWindowId(): string {
  return String(Math.floor(Date.now() / OTP_GLOBAL_SEND_WINDOW_MS));
}

/**
 * Atomically consumes one slot from the org-wide OTP-send budget for the
 * current window. Returns `true` if a slot was available (and has now been
 * consumed), `false` if this window's limit is already reached.
 *
 * Firestore transaction so concurrent requests (genuinely simultaneous
 * Cloud Function invocations) can't all read the same pre-increment count
 * and all believe they got the last slot — see
 * tests/integration/otpBudget.integration.test.ts, which is what actually
 * proves this against the real emulator (an offline mock can't validate
 * transaction semantics).
 *
 * Old window docs are never deleted here — add a Firestore TTL policy on
 * this collection at deploy time to reclaim that storage (same manual-step
 * pattern as the upload pipeline's Cloud Storage lifecycle policy).
 */
export async function consumeGlobalOtpBudget(): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(currentWindowId());

  return db.runTransaction(async (tx: any) => {
    const doc = await tx.get(ref);
    const count = doc.exists ? (doc.data().count as number) : 0;

    if (count >= OTP_GLOBAL_SEND_LIMIT) return false;

    tx.set(ref, { count: count + 1 }, { merge: true });
    return true;
  });
}
