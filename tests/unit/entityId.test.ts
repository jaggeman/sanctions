import { describe, it, expect } from 'vitest';
import { isValidEntityId } from '../../src/shared/entityId';

describe('isValidEntityId', () => {
  it('accepts real id shapes produced by the parsers', () => {
    expect(isValidEntityId('EU-1234')).toBe(true);
    expect(isValidEntityId('UN-5678')).toBe(true);
    expect(isValidEntityId('US-SDN-999')).toBe(true);
    expect(isValidEntityId('PEP-SE-1234')).toBe(true);
    expect(isValidEntityId('CUSTOM-1')).toBe(true);
  });

  it('accepts a bare Firestore auto-generated id (alphanumeric, no separators)', () => {
    expect(isValidEntityId('aB3dE9fGhIjK1lMnOpQr')).toBe(true);
  });

  it('accepts underscores', () => {
    expect(isValidEntityId('CUSTOM_watchlist_1')).toBe(true);
  });

  it('rejects an id containing a slash — the exact Firestore nested-path injection vector', () => {
    expect(isValidEntityId('EU-1/../../admins/attacker@example.com')).toBe(false);
    expect(isValidEntityId('a/b')).toBe(false);
  });

  it('rejects an id containing a dot', () => {
    expect(isValidEntityId('EU-1.10')).toBe(false);
  });

  it('rejects an id containing whitespace', () => {
    expect(isValidEntityId('EU 1234')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidEntityId('')).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(isValidEntityId(undefined)).toBe(false);
    expect(isValidEntityId(null)).toBe(false);
    expect(isValidEntityId(123 as any)).toBe(false);
    expect(isValidEntityId(['EU-1'] as any)).toBe(false);
  });

  it('rejects Firestore/Mongo-style special path segments', () => {
    expect(isValidEntityId('.')).toBe(false);
    expect(isValidEntityId('..')).toBe(false);
  });

  it('rejects other structural/special characters (@, #, $, %, spaces, control chars)', () => {
    expect(isValidEntityId('EU-1@evil.com')).toBe(false);
    expect(isValidEntityId('EU#1')).toBe(false);
    expect(isValidEntityId('EU\n1')).toBe(false);
  });
});
