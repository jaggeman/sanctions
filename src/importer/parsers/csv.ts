import * as fs from 'fs-extra';
import { SanctionRecord, SanctionType, SanctionSource, Address, NameAlias, BirthDate, Identification } from '../../shared/types';
import { logger } from '../../shared/logger';
import { isValidEntityId } from '../../shared/entityId';

const log = logger.child({ module: 'importer.parsers.csv' });

const ALLOWED_SOURCES = new Set<SanctionSource>(['EU', 'UN', 'US', 'UK', 'PEP', 'CUSTOM']);

/** Issue #6: CSV rows have no strong/language/precision markers — derived from the already-parsed row fields. */
function deriveNames(primaryName: string, aliases: string[]): NameAlias[] {
  const names: NameAlias[] = [{ wholeName: primaryName, strong: true }];
  for (const alias of aliases) names.push({ wholeName: alias, strong: false });
  return names;
}

function deriveBirthDates(datesOfBirth: string[]): BirthDate[] {
  return datesOfBirth.map((raw) => {
    const year = /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;
    return { raw, year };
  });
}

/**
 * A basic CSV line parser that handles double quotes and escapes.
 */
export function parseCSVLine(line: string, separator: string = ','): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === separator && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parsers a custom CSV file (e.g. Swedish PEP or Verklig Huvudman list) and maps it to SanctionRecord.
 */
export async function parseCSVList(
  filePath: string,
  options: {
    separator?: string;
    defaultSource?: SanctionSource;
  } = {}
): Promise<SanctionRecord[]> {
  const separator = options.separator || ';'; // default to semicolon which is common in Europe/Sweden
  const defaultSource: SanctionSource =
    options.defaultSource && ALLOWED_SOURCES.has(options.defaultSource)
      ? options.defaultSource
      : 'PEP';

  log.info('parse.start', { filePath, defaultSource });
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

  if (lines.length === 0) {
    return [];
  }

  // Parse header line to dynamically map fields
  const headers = parseCSVLine(lines[0], separator).map(h => h.toLowerCase());
  const hasIdHeader = headers.some(h => ['id', 'key', 'uid'].includes(h));
  const hasSourceHeader = headers.includes('source');
  const records: SanctionRecord[] = [];
  let skippedCount = 0;
  const skipReasons: Record<string, number> = {};

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], separator);
    if (values.length < headers.length) {
      skippedCount++;
      skipReasons.malformedColumns = (skipReasons.malformedColumns || 0) + 1;
      log.warn('parse.row_skipped_malformed_columns', { rowNumber: i, expected: headers.length, received: values.length });
      continue;
    }

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    // Extract fields using aliases
    const name = (row.name || row.primaryname || row.fullname || row.wholename || '').trim();
    if (!name) {
      skippedCount++;
      skipReasons.missingName = (skipReasons.missingName || 0) + 1;
      log.warn('parse.row_skipped_missing_name', { rowNumber: i });
      continue; // Primary name is required
    }

    // issue #167: Validate source. The file's own source column must not override
    // the source the import was invoked with (preventing cross-source overwrite of EU/US/etc. records).
    // If a source column is provided, it must match defaultSource.
    const rawSource = (row.source || '').trim().toUpperCase();
    if (hasSourceHeader && rawSource && rawSource !== defaultSource) {
      skippedCount++;
      skipReasons.sourceMismatch = (skipReasons.sourceMismatch || 0) + 1;
      log.warn('parse.row_skipped_source_mismatch', { rowNumber: i, rowSource: row.source, expectedSource: defaultSource });
      continue;
    }
    const source: SanctionSource = defaultSource;

    // issue #167: Validate entity ID against path injection and reserved words.
    // If an ID column is present in the CSV, empty or invalid IDs must be rejected.
    // If no ID column is present, synthesize a safe row-based ID (`row-${i}`).
    const rawId = (row.id || row.key || row.uid || (hasIdHeader ? '' : `row-${i}`)).trim();
    if (!rawId || !isValidEntityId(rawId)) {
      skippedCount++;
      skipReasons.invalidId = (skipReasons.invalidId || 0) + 1;
      log.warn('parse.row_skipped_invalid_id', { rowNumber: i, rawId });
      continue;
    }

    const typeStr = (row.type || row.category || 'individual').toLowerCase();
    const type: SanctionType = (typeStr.includes('entity') || typeStr.includes('organisation') || typeStr.includes('bolag'))
      ? 'entity'
      : (typeStr.includes('vessel') ? 'vessel' : (typeStr.includes('aircraft') ? 'aircraft' : 'individual'));

    const rawAliases = row.aliases || row.alias || '';
    const aliases = rawAliases ? rawAliases.split('|').map(s => s.trim()).filter(Boolean) : [];

    const rawDobs = row.datesofbirth || row.dob || row.birthdate || '';
    const datesOfBirth = rawDobs ? rawDobs.split('|').map(s => s.trim()).filter(Boolean) : [];

    const rawCitizenships = row.citizenships || row.citizenship || row.nationality || '';
    const citizenships = rawCitizenships ? rawCitizenships.split('|').map(s => s.trim()).filter(Boolean) : [];

    // issue #46: the CSV format carries no type/country columns for these
    // values, so a structured Identification here is just the bare number —
    // lossless equivalent of the old flat string list, not an invented breakdown.
    const rawPassports = row.passports || row.passport || row.idnumbers || row.ssn || row.pnr || '';
    const identifications: Identification[] = rawPassports
      ? rawPassports.split('|').map(s => s.trim()).filter(Boolean).map((number) => ({ number }))
      : [];

    const street = row.street || row.address || '';
    const city = row.city || '';
    const country = row.country || '';
    const fullAddress = row.fulladdress || [street, city, country].filter(Boolean).join(', ');

    const addresses: Address[] = fullAddress ? [{
      street: street || undefined,
      city: city || undefined,
      country: country || undefined,
      fullAddress: fullAddress || undefined,
    }] : [];

    const sanctionReason = row.reason || row.role || row.description || row.position || undefined;
    const legalBasis = row.legalbasis || row.law || undefined;

    const birthDates = deriveBirthDates(datesOfBirth);

    records.push({
      id: `${source}-${rawId}`,
      source,
      type,
      names: deriveNames(name, aliases),
      searchNames: [],
      birthDates: birthDates.length > 0 ? birthDates : undefined,
      citizenships: citizenships.length > 0 ? citizenships : undefined,
      identifications: identifications.length > 0 ? identifications : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason,
      legalBasis,
      rawSourceData: row,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  log.info('parse.complete', {
    filePath,
    recordCount: records.length,
    skippedCount,
    skipReasons,
  });
  return records;
}
