import * as fs from 'fs-extra';
import { SanctionRecord, SanctionType, SanctionSource, Address } from '../../shared/types';

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
  const defaultSource = options.defaultSource || 'PEP';

  console.log(`Parsing CSV list from ${filePath}...`);
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

  if (lines.length === 0) {
    return [];
  }

  // Parse header line to dynamically map fields
  const headers = parseCSVLine(lines[0], separator).map(h => h.toLowerCase());
  const records: SanctionRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], separator);
    if (values.length < headers.length) continue;

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    // Extract fields using aliases
    const rawId = row.id || row.key || row.uid || `row-${i}`;
    const name = row.name || row.primaryname || row.fullname || row.wholename || '';
    if (!name) continue; // Primary name is required

    const typeStr = (row.type || row.category || 'individual').toLowerCase();
    const type: SanctionType = (typeStr.includes('entity') || typeStr.includes('organisation') || typeStr.includes('bolag'))
      ? 'entity'
      : (typeStr.includes('vessel') ? 'vessel' : (typeStr.includes('aircraft') ? 'aircraft' : 'individual'));

    const source: SanctionSource = (row.source as SanctionSource) || defaultSource;

    const rawAliases = row.aliases || row.alias || '';
    const aliases = rawAliases ? rawAliases.split('|').map(s => s.trim()).filter(Boolean) : [];

    const rawDobs = row.datesofbirth || row.dob || row.birthdate || '';
    const datesOfBirth = rawDobs ? rawDobs.split('|').map(s => s.trim()).filter(Boolean) : [];

    const rawCitizenships = row.citizenships || row.citizenship || row.nationality || '';
    const citizenships = rawCitizenships ? rawCitizenships.split('|').map(s => s.trim()).filter(Boolean) : [];

    const rawPassports = row.passports || row.passport || row.idnumbers || row.ssn || row.pnr || '';
    const passports = rawPassports ? rawPassports.split('|').map(s => s.trim()).filter(Boolean) : [];

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

    records.push({
      id: `${source}-${rawId}`,
      source,
      type,
      primaryName: name,
      aliases,
      searchNames: [],
      datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
      citizenships: citizenships.length > 0 ? citizenships : undefined,
      passports: passports.length > 0 ? passports : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason,
      legalBasis,
      rawSourceData: row,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`Parsed ${records.length} CSV records.`);
  return records;
}
