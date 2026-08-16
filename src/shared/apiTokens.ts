import * as crypto from 'crypto';
import { db } from './firebase';
import { isAllowedEmail } from '../auth/emailAllowlist';
import { isAdminEmail } from '../auth/admins';

export type GranularApiTokenScope =
  | 'sanctions:read'
  | 'custom:read'
  | 'custom:write'
  | 'overrides:read'
  | 'overrides:write'
  | 'decisions:read'
  | 'decisions:write'
  | 'imports:read'
  | 'imports:write'
  | 'system:read';

export type LegacyApiTokenScope = 'read' | 'write';

export type ApiTokenScope = GranularApiTokenScope | LegacyApiTokenScope;

export interface ApiTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  tokenPreview: string;
  scopes: ApiTokenScope[];
  ownerEmail: string; // the admin who created this token — write attribution
  createdAt: string; // ISO string
  lastUsedAt: string | null; // ISO string
  revoked: boolean;
  revokedAt: string | null; // ISO string
  expiresAt: string | null; // ISO string — null means the token never expires
}

export type ApiTokenPublic = Omit<ApiTokenRecord, 'tokenHash'>;

export interface TokenVerificationResult {
  valid: boolean;
  reason?: 'missing' | 'not_found' | 'revoked' | 'expired' | 'insufficient_scope' | 'no_owner_email' | 'disallowed_owner' | 'disallowed_admin';
  tokenId?: string;
  scopes?: ApiTokenScope[];
  ownerEmail?: string;
}

const TOKEN_PREFIX = 'sanc_';
const TOKENS_COLLECTION = 'apiTokens';

const EXPIRY_DAYS: Record<'30d' | '90d' | '180d' | '365d', number> = {
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '365d': 365,
};

export type ApiTokenExpiryOption = keyof typeof EXPIRY_DAYS | 'never';

export const EXPIRY_OPTIONS: readonly ApiTokenExpiryOption[] = ['30d', '90d', '180d', '365d', 'never'];

export function isValidExpiryOption(value: unknown): value is ApiTokenExpiryOption {
  return typeof value === 'string' && (EXPIRY_OPTIONS as readonly string[]).includes(value);
}

/** Never throws — 'never' (and any option, by construction) always returns a value. */
export function computeExpiresAt(option: ApiTokenExpiryOption, from: Date = new Date()): string | null {
  if (option === 'never') return null;
  const days = EXPIRY_DAYS[option];
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export const READ_SCOPES: readonly GranularApiTokenScope[] = [
  'sanctions:read',
  'custom:read',
  'overrides:read',
  'decisions:read',
  'imports:read',
  'system:read',
];

export const WRITE_SCOPES: readonly GranularApiTokenScope[] = [
  'custom:write',
  'overrides:write',
  'decisions:write',
  'imports:write',
];

export const VALID_SCOPES: readonly ApiTokenScope[] = [
  'read',
  'write',
  ...READ_SCOPES,
  ...WRITE_SCOPES,
];

export function isWriteScope(scope: ApiTokenScope): boolean {
  return scope === 'write' || scope.endsWith(':write');
}

export function expandScopes(scopes: ApiTokenScope[]): Set<ApiTokenScope> {
  const expanded = new Set<ApiTokenScope>(scopes);
  if (expanded.has('read')) {
    for (const s of READ_SCOPES) expanded.add(s);
  }
  if (expanded.has('write')) {
    for (const s of WRITE_SCOPES) expanded.add(s);
  }
  return expanded;
}

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
    scopes.every((scope) => VALID_SCOPES.includes(scope as ApiTokenScope))
  );
}

function toPublic(record: ApiTokenRecord): ApiTokenPublic {
  const { tokenHash, ...rest } = record;
  return rest;
}

export async function createApiToken(
  name: string,
  scopes: ApiTokenScope[],
  ownerEmail: string,
  expiresIn: ApiTokenExpiryOption = 'never'
): Promise<{ token: string; record: ApiTokenPublic }> {
  if (!ownerEmail || !ownerEmail.trim()) {
    throw new Error('"ownerEmail" is required to create an API token.');
  }

  const rawToken = generateRawToken();
  const docRef = db.collection(TOKENS_COLLECTION).doc();

  const record: ApiTokenRecord = {
    id: docRef.id,
    name,
    tokenHash: hashToken(rawToken),
    tokenPreview: previewFromRawToken(rawToken),
    scopes,
    ownerEmail,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
    revokedAt: null,
    expiresAt: computeExpiresAt(expiresIn),
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
  requiredScope: ApiTokenScope | ApiTokenScope[],
  options?: { requireAdmin?: boolean }
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

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    return { valid: false, reason: 'expired', tokenId: record.id, scopes: record.scopes };
  }

  const effectiveScopes = expandScopes(record.scopes);
  const required = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  const matchingScope = required.find((s) => effectiveScopes.has(s));

  if (!matchingScope) {
    return { valid: false, reason: 'insufficient_scope', tokenId: record.id, scopes: record.scopes };
  }

  // Writes are attributed to the token's owner (overriddenBy/decidedBy) —
  // a token minted before ownerEmail existed has nothing to attribute to,
  // so fail closed rather than silently writing as an unknown actor. Reads
  // don't attribute anything, so they're let through unchanged.
  if (isWriteScope(matchingScope) && !record.ownerEmail) {
    return { valid: false, reason: 'no_owner_email', tokenId: record.id, scopes: record.scopes };
  }

  // CLAUDE.md §6 / issue #158: guards should re-verify current state from the
  // source of truth. If the token owner's domain was removed from
  // ALLOWED_EMAIL_DOMAINS (or the user off-boarded), fail closed so an
  // off-boarded user's tokens cannot keep access their session would immediately lose.
  if (record.ownerEmail && !isAllowedEmail(record.ownerEmail)) {
    return { valid: false, reason: 'disallowed_owner', tokenId: record.id, scopes: record.scopes };
  }

  // CLAUDE.md §6 / issue #297: re-verify admin rights from the source of truth on admin-gated calls.
  // If the token owner was removed from ADMIN_EMAILS (demoted/role change), fail closed
  // so a demoted admin's tokens cannot keep admin-only access their session would immediately lose.
  if (options?.requireAdmin && (!record.ownerEmail || !isAdminEmail(record.ownerEmail))) {
    return { valid: false, reason: 'disallowed_admin', tokenId: record.id, scopes: record.scopes };
  }

  // Fire-and-forget: don't make every authenticated request wait on this write.
  doc.ref.update({ lastUsedAt: new Date().toISOString() }).catch((err: unknown) => {
    console.error('Failed to update lastUsedAt for token', record.id, err);
  });

  return { valid: true, tokenId: record.id, scopes: record.scopes, ownerEmail: record.ownerEmail };
}
