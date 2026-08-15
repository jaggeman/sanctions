export type SanctionSource = 'EU' | 'UN' | 'US' | 'PEP' | 'CUSTOM';
export type SanctionType = 'individual' | 'entity' | 'vessel' | 'aircraft';

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
}
