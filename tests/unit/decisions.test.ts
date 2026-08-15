import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Decision } from '../../src/shared/types';

// Same fake-Firestore pattern as tests/unit/customRecords.test.ts, but the
// decisions collection is keyed by a composite entityId+subjectId id and
// also needs a `where('entityId', '==', ...)` query for listDecisionsForEntity.
let store: Record<string, Decision> = {};

function makeQuery(matching: Decision[]) {
  return {
    get: vi.fn(async () => ({
      forEach: (cb: (doc: any) => void) => {
        matching.forEach((d) => cb({ data: () => d }));
      },
    })),
  };
}

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'decisions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({
          exists: id in store,
          data: () => store[id],
        })),
        set: vi.fn(async (data: Decision) => {
          store[id] = data;
        }),
      })),
      where: vi.fn((field: string, op: string, value: any) => {
        if (field !== 'entityId' || op !== '==') throw new Error(`unexpected where(${field}, ${op})`);
        return makeQuery(Object.values(store).filter((d) => d.entityId === value));
      }),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { saveDecision, getDecision, listDecisionsForEntity } = await import('../../src/decisions');

beforeEach(() => {
  store = {};
  vi.clearAllMocks();
});

describe('saveDecision', () => {
  it('creates a new decision with a stamped decidedAt', async () => {
    const decision = await saveDecision({
      entityId: 'EU-1',
      subjectId: 'customer-acme',
      verdict: 'false_positive',
      decidedBy: 'analyst@example.com',
    });

    expect(decision.entityId).toBe('EU-1');
    expect(decision.subjectId).toBe('customer-acme');
    expect(decision.verdict).toBe('false_positive');
    expect(decision.decidedAt).toBeTruthy();
  });

  it('persists notes when provided', async () => {
    const decision = await saveDecision({
      entityId: 'EU-1',
      subjectId: 'customer-acme',
      verdict: 'true_positive',
      decidedBy: 'analyst@example.com',
      notes: 'Confirmed match on passport number',
    });
    expect(decision.notes).toBe('Confirmed match on passport number');
  });

  it('re-adjudication overwrites the prior decision for the same entity+subject (upsert)', async () => {
    await saveDecision({
      entityId: 'EU-1',
      subjectId: 'customer-acme',
      verdict: 'false_positive',
      decidedBy: 'analyst-a@example.com',
    });

    const updated = await saveDecision({
      entityId: 'EU-1',
      subjectId: 'customer-acme',
      verdict: 'true_positive',
      decidedBy: 'analyst-b@example.com',
    });

    expect(updated.verdict).toBe('true_positive');
    expect(updated.decidedBy).toBe('analyst-b@example.com');
    expect(Object.keys(store)).toHaveLength(1);
  });

  it('rejects a verdict outside the allowed enum', async () => {
    await expect(
      saveDecision({
        entityId: 'EU-1',
        subjectId: 'customer-acme',
        verdict: 'maybe' as any,
        decidedBy: 'analyst@example.com',
      }),
    ).rejects.toThrow(/verdict/i);
  });

  it('rejects a missing decidedBy', async () => {
    await expect(
      saveDecision({
        entityId: 'EU-1',
        subjectId: 'customer-acme',
        verdict: 'false_positive',
        decidedBy: '',
      }),
    ).rejects.toThrow(/decidedBy/i);
  });

  it('rejects an entityId containing a path separator (storage-key validation, CLAUDE.md §6)', async () => {
    await expect(
      saveDecision({
        entityId: 'EU-1/../other',
        subjectId: 'customer-acme',
        verdict: 'false_positive',
        decidedBy: 'analyst@example.com',
      }),
    ).rejects.toThrow(/entityId/i);
  });

  it('rejects a subjectId containing a path separator', async () => {
    await expect(
      saveDecision({
        entityId: 'EU-1',
        subjectId: 'customer/acme',
        verdict: 'false_positive',
        decidedBy: 'analyst@example.com',
      }),
    ).rejects.toThrow(/subjectId/i);
  });

  it('two different subjects for the same entity are stored independently', async () => {
    await saveDecision({ entityId: 'EU-1', subjectId: 'customer-a', verdict: 'false_positive', decidedBy: 'x@example.com' });
    await saveDecision({ entityId: 'EU-1', subjectId: 'customer-b', verdict: 'true_positive', decidedBy: 'x@example.com' });

    expect(Object.keys(store)).toHaveLength(2);
    const a = await getDecision('EU-1', 'customer-a');
    const b = await getDecision('EU-1', 'customer-b');
    expect(a?.verdict).toBe('false_positive');
    expect(b?.verdict).toBe('true_positive');
  });
});

describe('getDecision', () => {
  it('returns null when no decision exists for this entity+subject', async () => {
    expect(await getDecision('EU-404', 'customer-acme')).toBeNull();
  });

  it('returns the decision when it exists', async () => {
    await saveDecision({ entityId: 'EU-1', subjectId: 'customer-acme', verdict: 'false_positive', decidedBy: 'x@example.com' });
    const decision = await getDecision('EU-1', 'customer-acme');
    expect(decision?.entityId).toBe('EU-1');
  });
});

describe('listDecisionsForEntity', () => {
  it('returns an empty array when no decisions exist for the entity', async () => {
    expect(await listDecisionsForEntity('EU-404')).toEqual([]);
  });

  it('returns every decision for the entity across different subjects', async () => {
    await saveDecision({ entityId: 'EU-1', subjectId: 'customer-a', verdict: 'false_positive', decidedBy: 'x@example.com' });
    await saveDecision({ entityId: 'EU-1', subjectId: 'customer-b', verdict: 'true_positive', decidedBy: 'x@example.com' });
    await saveDecision({ entityId: 'EU-2', subjectId: 'customer-a', verdict: 'true_positive', decidedBy: 'x@example.com' });

    const decisions = await listDecisionsForEntity('EU-1');
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.subjectId).sort()).toEqual(['customer-a', 'customer-b']);
  });
});
