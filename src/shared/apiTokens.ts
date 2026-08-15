import * as crypto from 'crypto';
import { db } from './firebase';

export type ApiTokenScope = 'read' | 'write';

export interface ApiTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  tokenPreview: string;
  scopes: ApiTokenScope[];
  createdAt: string; // ISO string
  lastUsedAt: string | null; // ISO string
  revoked: boolean;
  revokedAt: string | null; // ISO string
}

export type ApiTokenPublic = Omit<ApiTokenRecord, 'tokenHash'>;

export interface TokenVerificationResult {
  valid: boolean;
  reason?: 'missing' | 'not_found' | 'revoked' | 'insufficient_scope';
  tokenId?: string;
  scopes?: ApiTokenScope[];
}

const TOKEN_PREFIX = 'sanc_';
const TOKENS_COLLECTION = 'apiTokens';
const VALID_SCOPES: ApiTokenScope[] = ['read', 'write'];

export function generateRawToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function previewFromRawToken(rawToken: string): string {
  return `${TOKEN_PREFIX}...${rawToken.slice(-4)}`;
}

export function validateScopes(scopes: unknown): scopes is ApiTokenScope[] {
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every((scope) => VALID_SCOPES.includes(scope))
  );
}

function toPublic(record: ApiTokenRecord): ApiTokenPublic {
  const { tokenHash, ...rest } = record;
  return rest;
}

export async function createApiToken(
  name: string,
  scopes: ApiTokenScope[]
): Promise<{ token: string; record: ApiTokenPublic }> {
  const rawToken = generateRawToken();
  const docRef = db.collection(TOKENS_COLLECTION).doc();

  const record: ApiTokenRecord = {
    id: docRef.id,
    name,
    tokenHash: hashToken(rawToken),
    tokenPreview: previewFromRawToken(rawToken),
    scopes,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
    revokedAt: null,
  };

  await docRef.set(record);

  return { token: rawToken, record: toPublic(record) };
}

export async function listApiTokens(): Promise<ApiTokenPublic[]> {
  const snapshot = await db.collection(TOKENS_COLLECTION).orderBy('createdAt', 'desc').get();
  return snapshot.docs.map((doc: any) => toPublic(doc.data() as ApiTokenRecord));
}

export async function revokeApiToken(id: string): Promise<ApiTokenPublic | null> {
  const docRef = db.collection(TOKENS_COLLECTION).doc(id);
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  const updates = { revoked: true, revokedAt: new Date().toISOString() };
  await docRef.update(updates);

  return toPublic({ ...(doc.data() as ApiTokenRecord), ...updates });
}

export async function verifyApiToken(
  rawToken: string | undefined,
  requiredScope: ApiTokenScope
): Promise<TokenVerificationResult> {
  if (!rawToken) {
    return { valid: false, reason: 'missing' };
  }

  const tokenHash = hashToken(rawToken);
  const snapshot = await db
    .collection(TOKENS_COLLECTION)
    .where('tokenHash', '==', tokenHash)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { valid: false, reason: 'not_found' };
  }

  const doc = snapshot.docs[0];
  const record = doc.data() as ApiTokenRecord;

  if (record.revoked) {
    return { valid: false, reason: 'revoked' };
  }

  if (!record.scopes.includes(requiredScope)) {
    return { valid: false, reason: 'insufficient_scope', tokenId: record.id, scopes: record.scopes };
  }

  // Fire-and-forget: don't make every authenticated request wait on this write.
  doc.ref.update({ lastUsedAt: new Date().toISOString() }).catch((err: unknown) => {
    console.error('Failed to update lastUsedAt for token', record.id, err);
  });

  return { valid: true, tokenId: record.id, scopes: record.scopes };
}
