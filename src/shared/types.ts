export type SanctionSource = 'EU' | 'UN' | 'US' | 'PEP' | 'CUSTOM';
export type SanctionType = 'individual' | 'entity' | 'vessel' | 'aircraft';

export interface Address {
  street?: string;
  city?: string;
  country?: string;
  fullAddress?: string;
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
}
