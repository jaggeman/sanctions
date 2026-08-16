export type SanctionSource = 'EU' | 'UN' | 'US' | 'UK' | 'PEP' | 'CUSTOM';

/**
 * Canonical internal vocabulary (issue #6). The EU FSD source uses
 * `person`/`enterprise` (subjectType@code), not these names — parsers map at
 * the parse boundary and this union is never widened to include the source's
 * own terms. Recorded here as the explicit decision issue #6 asks for: keep
 * `individual`/`entity`/`vessel`/`aircraft` as canonical, map everything else
 * onto it. (The "half-and-half" bug the issue describes was the EU parser
 * reading `code="I"`/`"E"` instead of `person`/`enterprise` — already fixed
 * in PR #13 by mapping at parse time, same as this decision.)
 */
export type SanctionType = 'individual' | 'entity' | 'vessel' | 'aircraft';
export type RecordStatus = 'active' | 'delisted';
export type ChangeType = 'created' | 'updated' | 'delisted' | 'relisted';

export interface Address {
  street?: string;
  city?: string;
  country?: string;
  fullAddress?: string;
  poBox?: string;
  region?: string;
  place?: string;
  countryIso2?: string;
}

/** One `<identification>` entry — a passport, national ID, or similar document. */
export interface Identification {
  number: string;
  typeCode?: string;
  typeDescription?: string;
  countryIso2?: string;
  issuedBy?: string;
  knownFalse?: boolean;
  knownExpired?: boolean;
  reportedLost?: boolean;
  revokedByIssuer?: boolean;
  diplomatic?: boolean;
}

/** The legal basis for a listing — `<regulation>` or `<regulationSummary>`. */
export interface Regulation {
  numberTitle?: string;
  programme?: string; // e.g. "IRQ"
  publicationDate?: string;
  entryIntoForceDate?: string;
  url?: string;
}

/** One `<nameAlias>` entry — a name or alias. See `primaryNameOf`/`aliasNamesOf` below for display. */
export interface NameAlias {
  wholeName: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  strong: boolean;
  language?: string;
  title?: string;
  function?: string;
}

/**
 * One `<birthdate>` entry. The source distinguishes an exact date from a
 * year-only value, a year *range*, and a `circa` (approximate) flag, none of
 * which survives collapsing to a plain string — see `formatBirthDates` below
 * for display.
 */
export interface BirthDate {
  raw?: string; // the full date as given, e.g. "1937-04-28", when present
  year?: number;
  month?: number;
  day?: number;
  yearRangeFrom?: number;
  yearRangeTo?: number;
  circa?: boolean;
  place?: string;
  city?: string;
  countryIso2?: string;
}

export interface ContactInfo {
  phoneNumbers?: string[];
  faxNumbers?: string[];
  emails?: string[];
  websites?: string[];
}

export interface Override {
  entityId: string; // matches SanctionRecord.id
  fields: Partial<Omit<SanctionRecord, 'id' | 'source' | 'type' | 'createdAt' | 'searchNames'>>;
  overriddenBy: string;
  overriddenAt: string; // ISO string
  reason: string;
}

export interface Decision {
  entityId: string;
  subjectId: string; // the customer/subject this adjudication was made for
  verdict: 'false_positive' | 'true_positive';
  decidedBy: string;
  decidedAt: string; // ISO string
  notes?: string;
}

// One entry in `decisions/{entityId__subjectId}/history/{autoId}` (issue
// #112) — same shape as sanctions/{id}/versions/{importId}: a full snapshot
// of the state that resulted from this change, tagged with what kind of
// change it was. `saveDecision`'s upsert-for-current-state behavior is
// unchanged; this is what keeps the prior verdict/author/notes recoverable
// once a second adjudication replaces them.
export type DecisionChangeType = 'created' | 'replaced';
export interface DecisionHistoryEntry {
  changeType: DecisionChangeType;
  changedAt: string; // ISO string
  decision: Decision;
}

// One entry in `overrides/{entityId}/history/{autoId}` (issue #112). For
// `changeType: 'deleted'`, `override` is the override as it stood just
// before removal (the thing that got removed) — `changedBy`/`changedAt`
// are the deleter's identity/time, not the original author's, so a delete
// is attributable even though `saveOverride`/`overriddenBy` never recorded
// a "deleter" field before this.
export type OverrideChangeType = 'created' | 'replaced' | 'deleted';
export interface OverrideHistoryEntry {
  changeType: OverrideChangeType;
  changedAt: string; // ISO string
  changedBy: string;
  override: Override;
}

export type ImportStatus = 'pending' | 'parsing' | 'applied' | 'failed' | 'rejected';
export type ImportFormat = 'eu-xml-1.1' | 'eu-csv-1.1' | 'eu-csv-1.0' | 'un-xml' | 'us-xml' | 'uk-xml' | 'csv';

// Audit trail for POST /api/upload (issue #7) AND POST /api/import (issue
// #111) — one collection, two triggers, discriminated by `trigger`. For an
// upload, document ID == sha256, which is the concurrency-safety mechanism:
// Firestore's doc.create() fails atomically if the ID already exists, so two
// concurrent uploads of the identical file can't both "win" the
// pending-creation race — see src/importer/importRecord.ts. For a
// fetch-triggered import there's no file/hash to dedup on, so the ID is a
// freshly generated importId per call instead. `status` stops at 'applied'
// rather than including a 'diffing' state, since the reconciliation/diff
// engine (issue #8) doesn't exist yet; this pipeline still runs the existing
// parse-everything upload path under the hood.
export interface ImportRecord {
  importId: string; // == sha256 for an upload; a generated id for a fetch
  trigger: 'upload' | 'fetch';
  // Upload-only fields (issue #7) — undefined for a fetch-triggered import.
  filename?: string;
  sha256?: string;
  sizeBytes?: number;
  storagePath?: string;
  source?: SanctionSource;
  format?: ImportFormat;
  fileGenerationDate?: string | null; // parsed from the file's own content, not the upload time
  // Fetch-triggered-only fields (issue #111) — undefined for an upload. A
  // fetch can span multiple sources in one call (POST /api/import's
  // `sources` array), unlike an upload which is always exactly one file/source.
  sources?: SanctionSource[];
  mode?: 'sync' | 'append'; // issue #8 — plain literal here, not importer/diff's ImportMode, to avoid a shared-types -> importer dependency
  force?: boolean;
  uploadedBy: string | null; // null until issue #3's auth lands on this endpoint
  uploadedAt: string; // ISO string
  status: ImportStatus;
  counts?: { parsed: number; uploaded: number };
  duplicateOfImportId?: string; // set when status is 'rejected'
  error?: string; // set when status is 'failed'
}

export interface SanctionRecord {
  id: string; // E.g., "EU-1234", "UN-5678", "US-SDN-9999", "PEP-SE-1234"
  source: SanctionSource;
  type: SanctionType;

  // --- Structured source fidelity (issue #6) — the only source of truth ---
  // (issue #46: the flat primaryName/aliases/datesOfBirth/passports fields
  // that used to live here were removed once every consumer was migrated to
  // read these instead — see primaryNameOf/aliasNamesOf/etc. below.)
  names: NameAlias[];
  searchNames: string[]; // Normalized search terms for basic search indexing

  firstNames?: string[];
  lastNames?: string[];
  titles?: string[];
  birthDates?: BirthDate[]; // structured, precision-aware form of a legacy flat date-of-birth list
  placesOfBirth?: string[];
  citizenships?: string[];
  identifications?: Identification[]; // passports, national IDs, and similar documents
  addresses?: Address[];

  sanctionReason?: string;
  legalBasis?: string;
  rawSourceData?: any; // Keep raw data in case of detailed auditing

  // --- Source fidelity & cross-referencing (issue #6, #99, #142) ---
  euReferenceNumber?: string; // the EU's own public identifier, e.g. "EU.27.28"

  /**
   * Cross-reference to the UN list, e.g. "QDi.399" (carried by EU, UK, and UN sources).
   *
   * Architectural decision (issue #142):
   * This field is informational metadata preserved for provenance, traceability, and
   * search-time cross-linking/grouping. Ingestion intentionally keeps separate, source-scoped
   * records (e.g. EU-123, UK-AFG0011, UN-5678) in the database rather than performing destructive
   * physical record merging across jurisdictions. This ensures auditability, preserves source
   * fidelity, avoids conflicting field reconciliations (names/addresses/DOBs), and prevents
   * cross-jurisdiction delisting/versioning race conditions.
   */
  unitedNationId?: string;
  sourceRef?: string; // the raw source-native id (e.g. EU logicalId, UK UniqueID), before any source prefix
  regulation?: Regulation;
  contactInfo?: ContactInfo;

  // --- Pipeline bookkeeping (issue #6) ---
  // status/listedAt/delistedAt/contentHash are owned by issue #9 (PR #25,
  // not yet merged as of this change) — deliberately not redefined here to
  // avoid a competing definition. See this feature's PR description for the
  // known contentHash/nested-field interaction that PR needs to account for.
  firstSeenImport?: string; // import id that first wrote this record
  lastSeenImport?: string; // import id that most recently wrote this record

  createdAt: string; // ISO string
  updatedAt: string; // ISO string

  // Soft delete + version history (issue #9). Never hard-delete a record that
  // came from an import — flip status instead, so the sanctions.rules
  // deny-all backstop and the audit trail in `sanctions/{id}/versions/{importId}`
  // stay meaningful. Optional so records written before this field existed
  // remain valid; callers should treat a missing status as 'active'.
  status?: RecordStatus;
  listedAt?: string; // ISO string — when this record first appeared in an import
  delistedAt?: string; // ISO string — when this record most recently went missing from an import
  // sha256 over the content fields only (excludes status/listedAt/delistedAt/
  // createdAt/updatedAt/searchNames) — used to tell a genuine content change
  // apart from a delist/relist cycle, so relisting doesn't look like an update.
  contentHash?: string;
}

// One entry in the `sanctions/{id}/versions/{importId}` subcollection.
// Written on create/update/delist/relist, never on an unchanged re-import.
export interface RecordVersion {
  importId: string;
  changedAt: string; // ISO string
  changeType: ChangeType;
  record: SanctionRecord; // full snapshot, per issue #9: simpler than a field-level delta
}

// One entry in the `searchLog` collection (issue #109) — a durable,
// queryable record of who searched for what, when. Written from
// src/api/routes/search.ts, never read back by the app today (no browsing
// UI yet — that's a separate future issue); server-only access, no direct
// client read/write path, per firestore.rules' blanket deny-all backstop.
export interface SearchLogEntry {
  id?: string; // Firestore doc id, present once read back
  action: 'search' | 'lookup'; // 'search' = GET /api/search, 'lookup' = GET /api/sanctions/:id
  requestedBy: string; // session: the user's email; token: `token:<tokenId>`
  query?: string; // the raw `q`, present for action: 'search'
  entityId?: string; // the looked-up record id, present for action: 'lookup'
  filters?: {
    source?: string;
    type?: string;
    threshold?: number;
    includeDelisted?: boolean;
    dob?: string;
  };
  resultCount: number; // totalMatches for a search; 1 (found) or 0 (not found) for a lookup
  timestamp: string; // ISO string
}

// --- Display helpers (issue #46) ---
// Every consumer that used to read the flat primaryName/aliases/datesOfBirth/
// passports fields now goes through these, so "how do we format a birth
// date/ID document" is decided once, not re-implemented per consumer (CLI,
// MCP, the frontend, search scoring).
//
// "Which name is primary" is deliberately just "whichever the parser put
// first" — every parser already picks its own best candidate using
// source-specific logic (e.g. the EU parser's strong/has-name-parts/
// preferred-language tie-break in selectPrimary) and is responsible for
// ordering `names` with that choice first. Re-deriving the choice here from
// `strong` alone would silently disagree with a parser whose selection logic
// is richer than "the first strong entry" — trusting the array's own order
// avoids two competing definitions of "primary" for the same record.

/** The record's primary display name: whichever entry its parser ordered first, else a placeholder. */
export function primaryNameOf(names: NameAlias[]): string {
  return names[0]?.wholeName || 'Unknown Name';
}

/** Every name after the primary, in original order. */
export function aliasNamesOf(names: NameAlias[]): string[] {
  return names.slice(1).map((n) => n.wholeName);
}

/** Every name (primary + aliases), for candidate-matching purposes where the distinction doesn't matter. */
export function allNamesOf(names: NameAlias[]): string[] {
  return names.map((n) => n.wholeName);
}

/** Formats each birth date as a single display/search string — the fullest precision available. */
export function formatBirthDates(birthDates?: BirthDate[]): string[] {
  return (birthDates || [])
    .map((b) => {
      if (b.raw) return b.raw;
      if (b.yearRangeFrom || b.yearRangeTo) {
        return `${b.yearRangeFrom ?? '?'}-${b.yearRangeTo ?? '?'}`;
      }
      if (b.year) {
        const parts = [b.year, b.month, b.day].filter((p): p is number => p !== undefined);
        return parts.join('-');
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * Formats each identification document as a single display/search string.
 * Carries the source's own reliability flags through to the caller (CLAUDE.md
 * §6: never present a known-false/expired/reported-lost/revoked document as
 * good data) rather than dropping them the way a bare number/type would.
 */
export function formatIdentifications(identifications?: Identification[]): string[] {
  return (identifications || [])
    .map((id) => {
      const label = id.typeDescription || id.typeCode;
      const country = id.countryIso2 ? ` (${id.countryIso2})` : '';
      const caveats = [
        id.knownFalse && 'known false',
        id.knownExpired && 'expired',
        id.reportedLost && 'reported lost',
        id.revokedByIssuer && 'revoked',
      ].filter(Boolean) as string[];
      const caveatSuffix = caveats.length > 0 ? ` [${caveats.join(', ')}]` : '';

      const base = label ? `${label} ${id.number}` : id.number;
      return `${base}${country}${caveatSuffix}`;
    })
    .filter(Boolean);
}
