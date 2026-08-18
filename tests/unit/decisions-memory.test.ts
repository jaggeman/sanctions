import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Decision, SanctionRecord } from '../../src/shared/types';
import {
  saveDecision,
  evaluateDecisionValidity,
  listDecisionsForSubject,
} from '../../src/decisions';

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    decisions: new Map<string, Decision>(),
    sanctions: new Map<string, any>(),
  };
  const fakeDb = {
    collection: vi.fn((name: string) => {
      if (name === 'decisions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const d = state.decisions.get(id);
              return { exists: Boolean(d), data: () => d, id };
            }),
            set: vi.fn(async (data: any) => {
              state.decisions.set(id, data);
            }),
            collection: vi.fn(() => ({
              doc: vi.fn(() => ({
                set: vi.fn(),
              })),
            })),
          })),
          where: vi.fn((field: string, _op: string, value: string) => ({
            get: vi.fn(async () => {
              const matched = Array.from(state.decisions.values()).filter((d: any) => d[field] === value);
              return {
                forEach: (cb: any) => matched.forEach((item) => cb({ data: () => item })),
                docs: matched.map((item) => ({ data: () => item })),
              };
            }),
          })),
        };
      }
      if (name === 'sanctions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const s = state.sanctions.get(id);
              return { exists: Boolean(s), data: () => s, id };
            }),
          })),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  };
  return { fakeDb, state };
});

vi.mock('../../src/shared/firebase', () => ({
  db: fakeDb,
}));

describe('Customer Decision Memory & Whitelisting (#320)', () => {
  beforeEach(() => {
    state.decisions.clear();
    state.sanctions.clear();
    vi.clearAllMocks();
  });

  describe('saveDecision with recordHash', () => {
    it('saves decision with entity recordHash for version pinning', async () => {
      const decision = await saveDecision({
        entityId: 'OFAC-999',
        subjectId: 'cust-12345',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        notes: 'Different birth date (1990 vs 1965)',
        recordHash: 'hash_abc123',
      });

      expect(decision.recordHash).toBe('hash_abc123');
      expect(decision.verdict).toBe('false_positive');
      expect(decision.subjectId).toBe('cust-12345');
    });
  });

  describe('evaluateDecisionValidity', () => {
    const baseRecord: SanctionRecord = {
      id: 'OFAC-999',
      source: 'US',
      type: 'individual',
      names: [{ wholeName: 'John Smith', isPrimary: true }],
      searchNames: ['john smith'],
      createdAt: '2026-01-01T00:00:00Z',
      contentHash: 'hash_v1',
    };

    it('returns valid when false_positive decision matches current record contentHash', () => {
      const decision: Decision = {
        entityId: 'OFAC-999',
        subjectId: 'cust-12345',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-10T10:00:00Z',
        recordHash: 'hash_v1',
      };

      const validity = evaluateDecisionValidity(decision, baseRecord);
      expect(validity.isValid).toBe(true);
      expect(validity.status).toBe('valid');
    });

    it('returns invalidated_data_changed when entity contentHash has updated since decision', () => {
      const decision: Decision = {
        entityId: 'OFAC-999',
        subjectId: 'cust-12345',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-10T10:00:00Z',
        recordHash: 'hash_v1_old',
      };

      const updatedRecord: SanctionRecord = {
        ...baseRecord,
        contentHash: 'hash_v2_new_alias_added',
      };

      const validity = evaluateDecisionValidity(decision, updatedRecord);
      expect(validity.isValid).toBe(false);
      expect(validity.status).toBe('invalidated_data_changed');
      expect(validity.reason).toContain('Sanction record was modified');
    });

    it('returns invalidated_expired when decision has an expired expiresAt date', () => {
      const decision: Decision = {
        entityId: 'OFAC-999',
        subjectId: 'cust-12345',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2025-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:00:00Z', // in past
        recordHash: 'hash_v1',
      };

      const validity = evaluateDecisionValidity(decision, baseRecord);
      expect(validity.isValid).toBe(false);
      expect(validity.status).toBe('invalidated_expired');
    });

    it('returns not_whitelisted when decision verdict is true_positive', () => {
      const decision: Decision = {
        entityId: 'OFAC-999',
        subjectId: 'cust-12345',
        verdict: 'true_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-10T10:00:00Z',
        recordHash: 'hash_v1',
      };

      const validity = evaluateDecisionValidity(decision, baseRecord);
      expect(validity.isValid).toBe(false);
      expect(validity.status).toBe('not_whitelisted');
    });
  });

  describe('listDecisionsForSubject', () => {
    it('returns all decisions associated with a customer subject ID', async () => {
      state.decisions.set('EU-1__cust-99', {
        entityId: 'EU-1',
        subjectId: 'cust-99',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-15T12:00:00Z',
      });
      state.decisions.set('UN-2__cust-99', {
        entityId: 'UN-2',
        subjectId: 'cust-99',
        verdict: 'true_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-16T12:00:00Z',
      });
      state.decisions.set('EU-3__other-cust', {
        entityId: 'EU-3',
        subjectId: 'other-cust',
        verdict: 'false_positive',
        decidedBy: 'analyst@corp.test',
        decidedAt: '2026-08-17T12:00:00Z',
      });

      const results = await listDecisionsForSubject('cust-99');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.entityId)).toEqual(['UN-2', 'EU-1']);
    });
  });
});
