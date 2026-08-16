import { db } from '../shared/firebase';
import { Decision, DecisionChangeType, DecisionHistoryEntry } from '../shared/types';

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

  const decision: Decision = {
    entityId: input.entityId,
    subjectId: input.subjectId,
    verdict: input.verdict,
    decidedBy: input.decidedBy,
    decidedAt: new Date().toISOString(),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
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

  return decision;
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
