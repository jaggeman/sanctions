export type SanctionSource = 'EU' | 'UN' | 'US' | 'PEP' | 'CUSTOM';
export type SanctionType = 'individual' | 'entity' | 'vessel' | 'aircraft';
export type RecordStatus = 'active' | 'delisted';
export type ChangeType = 'created' | 'updated' | 'delisted' | 'relisted';

export interface Address {
  street?: string;
  city?: string;
  country?: string;
  fullAddress?: string;
}

export interface SanctionRecord {
  id: string; // E.g., "EU-1234", "UN-5678", "US-SDN-9999", "PEP-SE-1234"
  source: SanctionSource;
  type: SanctionType;
  primaryName: string;
  aliases: string[];
  searchNames: string[]; // Normalized search terms for basic search indexing
  
  firstNames?: string[];
  lastNames?: string[];
  titles?: string[];
  datesOfBirth?: string[];
  placesOfBirth?: string[];
  citizenships?: string[];
  passports?: string[]; // IDs, passports, etc.
  addresses?: Address[];
  
  sanctionReason?: string;
  legalBasis?: string;
  rawSourceData?: any; // Keep raw data in case of detailed auditing
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
