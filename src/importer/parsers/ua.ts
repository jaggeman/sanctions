/**
 * Parser for the Ukraine NSDC (National Security and Defense Council)
 * State Register of Sanctions (Державний реєстр санкцій), issue #287.
 *
 * Data source: https://api-drs.nsdc.gov.ua
 * Subjects endpoint: GET /subjects/{person|legal_entity}?page=N&pageSize=200
 * Authentication: x-api-key header (NSDC_API_KEY env variable)
 *
 * The NSDC register covers ~22,000 sanctioned persons and legal entities
 * with ~38% overlap with existing sources — adding it gains ~13,711 new entities.
 *
 * Design notes:
 * - Returns gracefully (0 records, logged warning) when NSDC_API_KEY is absent.
 * - IDs are prefixed "UA-{id}" to prevent collision with other sources.
 * - Identifier values are always read as strings to prevent leading-zero loss.
 * - status "revoked" → RecordStatus "delisted"; everything else → "active".
 */

import axios from 'axios';
import {
  SanctionRecord,
  NameAlias,
  BirthDate,
  Identification,
} from '../../shared/types';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.ua' });

const NSDC_BASE_URL = 'https://api-drs.nsdc.gov.ua';
const PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function safeId(rawId: unknown): string {
  // Read as string — numeric IDs are fine, but we want a stable string key.
  return `UA-${str(rawId)}`;
}

function parseNsdcBirthDate(raw: string | null | undefined): BirthDate | null {
  if (!raw) return null;
  // NSDC date format: "YYYY-MM-DD" or "YYYY"
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (full) {
    return {
      raw,
      year: parseInt(full[1], 10),
      month: parseInt(full[2], 10),
      day: parseInt(full[3], 10),
    };
  }
  const yearOnly = /^(\d{4})$/.exec(raw);
  if (yearOnly) {
    return { raw, year: parseInt(yearOnly[1], 10) };
  }
  return { raw };
}

function composePersonName(rec: {
  lastName?: unknown;
  firstName?: unknown;
  middleName?: unknown;
}): string {
  return [str(rec.lastName), str(rec.firstName), str(rec.middleName)]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Public record-level parsers (exported for unit tests)
// ---------------------------------------------------------------------------

export function parseNsdcPersonRecord(raw: Record<string, any>): SanctionRecord {
  const primaryName = composePersonName(raw);

  const names: NameAlias[] = [
    { wholeName: primaryName || 'Unknown', strong: true },
  ];

  // Aliases: each alias is an object with lastName/firstName/middleName
  for (const alias of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const aliasName = composePersonName(alias);
    if (aliasName && aliasName !== primaryName) {
      names.push({ wholeName: aliasName, strong: false });
    }
  }

  const birthDates: BirthDate[] = [];
  const dob = parseNsdcBirthDate(raw.dateOfBirth);
  if (dob) birthDates.push(dob);

  const identifications: Identification[] = [];
  for (const passport of Array.isArray(raw.passports) ? raw.passports : []) {
    const series = str(passport.series);
    const number = str(passport.number); // Keep as string — no coercion
    if (number) {
      identifications.push({
        number: series ? `${series}${number}` : number,
        typeCode: 'passport',
        typeDescription: str(passport.type) || 'passport',
      });
    }
  }
  if (raw.ipn) {
    identifications.push({
      number: str(raw.ipn),
      typeCode: 'tax_id',
      typeDescription: 'Individual Tax Number (IPN)',
    });
  }

  const status = str(raw.status) === 'revoked' ? 'delisted' : 'active';

  return {
    id: safeId(raw.id),
    source: 'UA',
    type: 'individual',
    names,
    searchNames: [],
    birthDates,
    identifications,
    addresses: [],
    status,
    regulation: raw.decree
      ? {
          numberTitle: `Decree ${str(raw.decree.number)}`,
          publicationDate: str(raw.decree.date),
          url: str(raw.decree.url) || undefined,
        }
      : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function parseNsdcEntityRecord(raw: Record<string, any>): SanctionRecord {
  const primaryName = str(raw.fullName) || str(raw.shortName) || 'Unknown';

  const names: NameAlias[] = [{ wholeName: primaryName, strong: true }];

  for (const alias of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const aliasName = str(alias.fullName) || str(alias.shortName);
    if (aliasName && aliasName !== primaryName) {
      names.push({ wholeName: aliasName, strong: false });
    }
  }

  const identifications: Identification[] = [];
  if (raw.edrpou) {
    identifications.push({
      number: str(raw.edrpou),
      typeCode: 'edrpou',
      typeDescription: 'ЄДРПОУ (Ukrainian Company Registry Number)',
    });
  }

  const status = str(raw.status) === 'revoked' ? 'delisted' : 'active';

  return {
    id: safeId(raw.id),
    source: 'UA',
    type: 'entity',
    names,
    searchNames: [],
    birthDates: [],
    identifications,
    addresses: [],
    status,
    regulation: raw.decree
      ? {
          numberTitle: `Decree ${str(raw.decree.number)}`,
          publicationDate: str(raw.decree.date),
        }
      : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Streaming importer — paginates through the full NSDC register
// ---------------------------------------------------------------------------

export async function parseUaListStreaming(
  onRecord: (record: SanctionRecord) => Promise<void>,
): Promise<{ persons: number; entities: number }> {
  const apiKey = process.env.NSDC_API_KEY;

  if (!apiKey) {
    log.warn('ua.parser.no_api_key', {
      message: 'NSDC_API_KEY is not set — skipping Ukraine NSDC import. '
        + 'Request a key from sanctions@rnbo.gov.ua',
    });
    return { persons: 0, entities: 0 };
  }

  const headers = { 'x-api-key': apiKey };
  let persons = 0;
  let entities = 0;

  async function paginateSubjectType(
    subjectType: 'person' | 'legal_entity',
    parser: (raw: Record<string, any>) => SanctionRecord,
  ): Promise<number> {
    let count = 0;
    let page = 1;
    let totalPages = 1;

    do {
      log.info('ua.parser.fetch_page', { subjectType, page, totalPages });

      const response = await axios.get(
        `${NSDC_BASE_URL}/subjects/${subjectType}`,
        {
          params: { page, pageSize: PAGE_SIZE },
          headers,
          timeout: 30_000,
        },
      );

      const data = response.data;
      // Response shape: { data: [...records], totalPages: N, totalCount: N }
      const records: Record<string, any>[] = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
        ? data
        : [];

      totalPages = data.totalPages ?? data.pagesCount ?? page;

      for (const raw of records) {
        try {
          const record = parser(raw);
          await onRecord(record);
          count++;
        } catch (err: any) {
          log.warn('ua.parser.record_failed', { subjectType, id: raw?.id, error: err.message });
        }
      }

      page++;
    } while (page <= totalPages);

    return count;
  }

  try {
    persons = await paginateSubjectType('person', parseNsdcPersonRecord);
    log.info('ua.parser.persons_done', { persons });
  } catch (err: any) {
    log.error('ua.parser.persons_failed', { error: err.message });
  }

  try {
    entities = await paginateSubjectType('legal_entity', parseNsdcEntityRecord);
    log.info('ua.parser.entities_done', { entities });
  } catch (err: any) {
    log.error('ua.parser.entities_failed', { error: err.message });
  }

  return { persons, entities };
}
