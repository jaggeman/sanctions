import { db } from '../shared/firebase';
import {
  Decision,
  DecisionChangeType,
  DecisionHistoryEntry,
  DecisionValidity,
  SanctionRecord,
} from '../shared/types';
import { dispatchWebhookEvent } from '../webhooks';

const COLLECTION = 'decisions';
const VALID_VERDICTS = new Set(['false_positive', 'true_positive']);
// entityId/subjectId become a Firestore doc id segment below — allow-list
// pattern per CLAUDE.md §6, reject path separators and other structural
// characters rather than trying to blocklist specific bad values.
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface SaveDecisionInput {
  entityId: string;
  subjectId: string;
  verdict: 'false_positive' | 'true_positive';
  decidedBy: string;
  notes?: string;
  recordHash?: string;
  expiresAt?: string | null;
}

function decisionDocId(entityId: string, subjectId: string): string {
  return `${entityId}__${subjectId}`;
}

/**
 * Creates or overwrites the current adjudication for an entity+subject pair.
 * Deliberately an upsert, not create-only: re-adjudicating (an analyst
 * revisiting or a second analyst disagreeing) is the normal case this
 * collection exists to make cheap, not an error.
 */
export async function saveDecision(input: SaveDecisionInput): Promise<Decision> {
  if (!input.entityId || !SAFE_KEY_SEGMENT.test(input.entityId)) {
    throw new Error('"entityId" must be a non-empty string of letters, numbers, "-", or "_".');
  }
  if (!input.subjectId || !SAFE_KEY_SEGMENT.test(input.subjectId)) {
    throw new Error('"subjectId" must be a non-empty string of letters, numbers, "-", or "_".');
  }
  if (!VALID_VERDICTS.has(input.verdict)) {
    throw new Error('"verdict" must be "false_positive" or "true_positive".');
  }
  if (!input.decidedBy || !input.decidedBy.trim()) {
    throw new Error('"decidedBy" is required.');
  }

  let recordHash = input.recordHash;
  if (!recordHash) {
    try {
      const sanctionDoc = await db.collection('sanctions').doc(input.entityId).get();
      if (sanctionDoc.exists) {
        const data = sanctionDoc.data() as SanctionRecord;
        recordHash = data?.contentHash;
      }
    } catch {
      // Best-effort lookup
    }
  }

  const decision: Decision = {
    entityId: input.entityId,
    subjectId: input.subjectId,
    verdict: input.verdict,
    decidedBy: input.decidedBy,
    decidedAt: new Date().toISOString(),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(recordHash ? { recordHash } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };

  const docRef = db.collection(COLLECTION).doc(decisionDocId(input.entityId, input.subjectId));
  const existing = await docRef.get();
  const changeType: DecisionChangeType = existing.exists ? 'replaced' : 'created';

  await docRef.set(decision);

  // Append-only history (issue #112) — the current-state doc above is a
  // plain upsert (re-adjudicating is the normal case, not an error), but
  // the prior verdict/author/notes must stay recoverable rather than
  // silently overwritten. Written after the primary doc: if this write
  // fails, current-state reads are still correct, just missing one
  // history entry, which is the higher-priority guarantee.
  const historyEntry: DecisionHistoryEntry = { changeType, changedAt: decision.decidedAt, decision };
  await docRef.collection('history').doc().set(historyEntry);

  // Dispatch webhook event asynchronously (issue #318)
  dispatchWebhookEvent('decision.recorded', decision).catch(() => {});

  return decision;
}

/**
 * Checks whether a previously recorded false-positive decision is still valid
 * against the entity's current record version (issue #320).
 */
export function evaluateDecisionValidity(
  decision: Decision,
  currentRecord?: SanctionRecord | null,
): DecisionValidity {
  if (decision.verdict !== 'false_positive') {
    return {
      isValid: false,
      status: 'not_whitelisted',
      reason: 'Decision is True Positive (active risk alert)',
    };
  }

  if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= Date.now()) {
    return {
      isValid: false,
      status: 'invalidated_expired',
      reason: `Whitelist clearance expired on ${new Date(decision.expiresAt).toLocaleDateString()}`,
    };
  }

  if (
    currentRecord &&
    decision.recordHash &&
    currentRecord.contentHash &&
    decision.recordHash !== currentRecord.contentHash
  ) {
    return {
      isValid: false,
      status: 'invalidated_data_changed',
      reason: 'Sanction record was modified with new aliases or data since clearance was recorded',
    };
  }

  return {
    isValid: true,
    status: 'valid',
  };
}

export async function getDecision(entityId: string, subjectId: string): Promise<Decision | null> {
  const doc = await db.collection(COLLECTION).doc(decisionDocId(entityId, subjectId)).get();
  if (!doc.exists) return null;
  return doc.data() as Decision;
}

export async function listDecisionsForEntity(entityId: string): Promise<Decision[]> {
  const snapshot = await db.collection(COLLECTION).where('entityId', '==', entityId).get();
  const decisions: Decision[] = [];
  snapshot.forEach((doc: any) => decisions.push(doc.data() as Decision));
  return decisions;
}

/**
 * Retrieves all adjudications linked to a specific customer subject ID (issue #320).
 */
export async function listDecisionsForSubject(subjectId: string): Promise<Decision[]> {
  const snapshot = await db.collection(COLLECTION).where('subjectId', '==', subjectId).get();
  const decisions: Decision[] = [];
  snapshot.forEach((doc: any) => decisions.push(doc.data() as Decision));
  return decisions.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

/**
 * Full change history for an entity+subject pair, most recent first —
 * every prior adjudication that `saveDecision`'s upsert has since
 * overwritten in the current-state doc (issue #112).
 */
export async function getDecisionHistory(entityId: string, subjectId: string): Promise<DecisionHistoryEntry[]> {
  const snapshot = await db
    .collection(COLLECTION)
    .doc(decisionDocId(entityId, subjectId))
    .collection('history')
    .orderBy('changedAt', 'desc')
    .get();
  return snapshot.docs.map((doc: any) => doc.data() as DecisionHistoryEntry);
}

