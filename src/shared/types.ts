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

/** One `<nameAlias>` entry — the structured form `primaryName`/`aliases` are derived from. */
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
 * year-only value, a year *range*, and a `circa` (approximate) flag — the
 * legacy `datesOfBirth: string[]` collapses all of that into a plain string.
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

// Design-only for issue #10 — no persistence/CRUD/API built yet. Tracked for
// the actual build in a follow-up issue (see PR description).
export interface Decision {
  entityId: string;
  subjectId: string; // the customer/subject this adjudication was made for
  verdict: 'false_positive' | 'true_positive';
  decidedBy: string;
  decidedAt: string; // ISO string
  notes?: string;
}

export type ImportStatus = 'pending' | 'parsing' | 'applied' | 'failed' | 'rejected';
export type ImportFormat = 'eu-xml-1.1' | 'eu-csv-1.1' | 'eu-csv-1.0' | 'un-xml' | 'us-xml' | 'csv';

// Audit trail for POST /api/upload (issue #7). Document ID == sha256, which
// is the concurrency-safety mechanism: Firestore's doc.create() fails
// atomically if the ID already exists, so two concurrent uploads of the
// identical file can't both "win" the pending-creation race — see
// src/importer/importRecord.ts. `status` stops at 'applied' rather than
// including a 'diffing' state, since the reconciliation/diff engine (issue
// #8) doesn't exist yet; this pipeline still runs the existing
// parse-everything upload path under the hood.
export interface ImportRecord {
  importId: string; // == sha256
  filename: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  source: SanctionSource;
  format: ImportFormat;
  fileGenerationDate: string | null; // parsed from the file's own content, not the upload time
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

  // --- Flat fields (kept for backward compatibility, issue #6) ---
  // Every already-shipped consumer (search/matcher.ts, uploader.ts's
  // generateSearchTokens, the frontend) reads these directly. The EU parser
  // derives them from `names`/`birthDates` below rather than dropping them;
  // a follow-up issue tracks actually removing them once the several other
  // in-flight PRs that also read this shape have landed.
  primaryName: string;
  aliases: string[];
  searchNames: string[]; // Normalized search terms for basic search indexing

  firstNames?: string[];
  lastNames?: string[];
  titles?: string[];
  datesOfBirth?: string[];
  placesOfBirth?: string[];
  citizenships?: string[];
  passports?: string[]; // IDs, passports, etc. — derived from `identifications` when present
  addresses?: Address[];

  sanctionReason?: string;
  legalBasis?: string;
  rawSourceData?: any; // Keep raw data in case of detailed auditing

  // --- EU FSD v1.1 source fidelity (issue #6) ---
  euReferenceNumber?: string; // the EU's own public identifier, e.g. "EU.27.28"
  unitedNationId?: string; // cross-reference to the UN list, e.g. "QDi.399"
  sourceRef?: string; // the raw source-native id (e.g. EU logicalId), before any "EU-" prefix
  identifications?: Identification[];
  regulation?: Regulation;
  names?: NameAlias[]; // structured form; primaryName/aliases above are derived from this when present
  birthDates?: BirthDate[]; // structured, precision-aware form of datesOfBirth
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
