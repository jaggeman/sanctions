import {
  SanctionRecord,
  primaryNameOf,
  aliasNamesOf,
  formatBirthDates,
  formatIdentifications,
} from './types';

export const CSV_HEADERS = [
  'id',
  'source',
  'type',
  'primaryName',
  'aliases',
  'status',
  'score',
  'matchedAlias',
  'birthDates',
  'placesOfBirth',
  'citizenships',
  'identifications',
  'addresses',
  'sanctionReason',
  'legalBasis',
  'unitedNationId',
  'euReferenceNumber',
  'listedAt',
  'delistedAt',
  'updatedAt',
] as const;

export type CsvHeader = typeof CSV_HEADERS[number];

/**
 * Escapes a single CSV field per RFC 4180.
 * If the value contains commas, double quotes, or newlines, it wraps the
 * value in quotes and escapes internal double quotes as `""`.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str === '') return '';

  const needsQuotes = /[",\r\n]/.test(str);
  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CsvRecordInput extends Partial<Omit<SanctionRecord, 'source' | 'type'>> {
  id: string;
  source: string;
  type?: any;
  score?: number;
  matchedAlias?: string;
}

/**
 * Serializes a SanctionRecord (or a scored search hit) into an RFC 4180 CSV row.
 */
export function sanctionRecordToCsvRow(record: CsvRecordInput): string {
  const primaryName = record.names ? primaryNameOf(record.names) : 'Unknown Name';
  const aliases = record.names ? aliasNamesOf(record.names).join('; ') : '';
  const birthDates = formatBirthDates(record.birthDates).join('; ');
  const placesOfBirth = (record.placesOfBirth || []).join('; ');
  const citizenships = (record.citizenships || []).join('; ');
  const identifications = formatIdentifications(record.identifications).join('; ');
  const addresses = (record.addresses || [])
    .map((a) => a.fullAddress || [a.street, a.city, a.country].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');

  const fields: string[] = [
    escapeCsvField(record.id),
    escapeCsvField(record.source),
    escapeCsvField(record.type),
    escapeCsvField(primaryName),
    escapeCsvField(aliases),
    escapeCsvField(record.status || 'active'),
    escapeCsvField(record.score !== undefined ? record.score : ''),
    escapeCsvField(record.matchedAlias || ''),
    escapeCsvField(birthDates),
    escapeCsvField(placesOfBirth),
    escapeCsvField(citizenships),
    escapeCsvField(identifications),
    escapeCsvField(addresses),
    escapeCsvField(record.sanctionReason || ''),
    escapeCsvField(record.legalBasis || ''),
    escapeCsvField(record.unitedNationId || ''),
    escapeCsvField(record.euReferenceNumber || ''),
    escapeCsvField(record.listedAt || record.createdAt || ''),
    escapeCsvField(record.delistedAt || ''),
    escapeCsvField(record.updatedAt || ''),
  ];

  return fields.join(',');
}

/**
 * Serializes an array of records into a complete RFC 4180 CSV document.
 */
export function recordsToCsv(records: CsvRecordInput[]): string {
  const headerRow = CSV_HEADERS.map(escapeCsvField).join(',');
  const rows = records.map(sanctionRecordToCsvRow);
  return [headerRow, ...rows].join('\r\n');
}
