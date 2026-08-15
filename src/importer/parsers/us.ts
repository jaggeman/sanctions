import { SanctionRecord, Address, NameAlias, BirthDate } from '../../shared/types';
import { streamXmlRecords } from './xmlSubtreeStream';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.us' });

/**
 * Issue #6: OFAC SDN has no strong/language markers on aliases and no
 * date-precision beyond whatever string `dateOfBirth` already is — derived
 * from the already-computed primary name/aliases/dates rather than invented.
 */
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
 * Parser for the US Treasury OFAC Specially Designated Nationals (SDN) list.
 *
 * Streaming since issue #31: the real SDN export (~29 MB, ~19 200 entries) was
 * measured against the deployed Cloud Function's actual memory ceiling
 * (256 MiB, no `runWith` override) using the previous full-DOM
 * (`fast-xml-parser`) parse — peak RSS came in at ~317 MB, over budget, and
 * one run of that measurement crashed outright with a JS heap OOM. The UN
 * consolidated list was measured the same way and found to be no risk (a
 * ~2 MB file, comfortably under budget even at a 64 MB ceiling) — see issue
 * #31 and this PR's description for the numbers. `un.ts` is therefore left
 * as-is; only this file changes.
 *
 * `parseUSListStreaming` builds one `<sdnEntry>` subtree at a time (via the
 * shared engine in `xmlSubtreeStream.ts`, the same one issue #5 built for the
 * EU parser) and discards it before the next one, rather than holding a DOM
 * tree over the whole document.
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * `uid` becomes part of a Firestore document ID (`US-SDN-<uid>`). It arrives
 * from a downloaded file, so it's validated rather than trusted — the same
 * gap the EU parser closed in issue #5 for `logicalId`.
 */
const SAFE_UID = /^[A-Za-z0-9._-]{1,200}$/;

function mapEntryToRecord(entry: any): SanctionRecord | null {
  const uid = String(entry.uid ?? '').trim();
  if (!uid) return null;
  if (!SAFE_UID.test(uid)) {
    log.warn('entry.skipped_unsafe_uid', { uid });
    return null;
  }

  const sdnTypeStr = String(entry.sdnType || '').toLowerCase();

  let type: 'individual' | 'entity' | 'vessel' | 'aircraft' = 'entity';
  if (sdnTypeStr === 'individual') type = 'individual';
  else if (sdnTypeStr === 'vessel') type = 'vessel';
  else if (sdnTypeStr === 'aircraft') type = 'aircraft';

  const first = entry.firstName ? String(entry.firstName) : '';
  const last = entry.lastName ? String(entry.lastName) : '';
  const primaryName = first ? `${first} ${last}`.trim() : last.trim();

  // Map aliases (AKA)
  const aliases: string[] = [];
  for (const aka of toArray(entry.akaList?.aka)) {
    const akaFirst = aka.firstName ? String(aka.firstName) : '';
    const akaLast = aka.lastName ? String(aka.lastName) : '';
    const akaName = akaFirst ? `${akaFirst} ${akaLast}`.trim() : akaLast.trim();
    if (akaName && !aliases.includes(akaName)) {
      aliases.push(akaName);
    }
  }

  // Map addresses
  const addresses: Address[] = [];
  for (const addr of toArray(entry.addressList?.address)) {
    const a1 = addr.address1 ? String(addr.address1) : '';
    const a2 = addr.address2 ? String(addr.address2) : '';
    const a3 = addr.address3 ? String(addr.address3) : '';
    const city = addr.city ? String(addr.city) : '';
    const state = addr.stateOrProvince ? String(addr.stateOrProvince) : '';
    const zip = addr.postalCode ? String(addr.postalCode) : '';
    const country = addr.country ? String(addr.country) : '';

    const fullParts = [a1, a2, a3, city, state, zip, country].filter(Boolean);
    addresses.push({
      street: [a1, a2, a3].filter(Boolean).join(', ') || undefined,
      city: city || undefined,
      country: country || undefined,
      fullAddress: fullParts.join(', ') || undefined,
    });
  }

  // Map birth details
  const datesOfBirth: string[] = [];
  for (const dobItem of toArray(entry.dateOfBirthList?.dateOfBirthItem)) {
    if (dobItem.dateOfBirth) {
      datesOfBirth.push(String(dobItem.dateOfBirth));
    }
  }

  const placesOfBirth: string[] = [];
  for (const pobItem of toArray(entry.placeOfBirthList?.placeOfBirthItem)) {
    if (pobItem.placeOfBirth) {
      placesOfBirth.push(String(pobItem.placeOfBirth));
    }
  }

  // Map IDs (passports, national ID, etc.)
  const passports: string[] = [];
  for (const idItem of toArray(entry.idList?.id)) {
    const num = idItem.idNumber ? String(idItem.idNumber) : '';
    const idType = idItem.idType ? String(idItem.idType) : '';
    const country = idItem.idCountry ? String(idItem.idCountry) : '';
    if (num) {
      const detail = idType ? `${idType} ${num}${country ? ` (${country})` : ''}` : num;
      passports.push(detail);
    }
  }

  // Map program details as sanction reason
  const programs = toArray(entry.programList?.program).map((p) => String(p));
  const sanctionReason = programs.join(', ');

  // Structured fields from #44. Derived from the flat ones rather than
  // invented: OFAC SDN carries no strong/language markers on aliases and no
  // date precision beyond the raw string.
  const birthDates = deriveBirthDates(datesOfBirth);

  const now = new Date().toISOString();

  return {
    id: `US-SDN-${uid}`,
    source: 'US',
    type,
    primaryName,
    aliases,
    searchNames: [], // Generated by uploader
    names: deriveNames(primaryName, aliases),
    datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
    birthDates: birthDates.length > 0 ? birthDates : undefined,
    placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
    passports: passports.length > 0 ? passports : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    sanctionReason: sanctionReason || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolves to the number of `sdnEntry` subtrees for which `onRecord` was
 * actually invoked (entries skipped for a missing/unsafe `uid` are not
 * counted) — same contract as `parseEUListStreaming`.
 */
export async function parseUSListStreaming(
  filePath: string,
  onRecord: (record: SanctionRecord) => void | Promise<void>,
): Promise<number> {
  log.info('stream.start', { filePath });
  let emitted = 0;

  await streamXmlRecords(filePath, 'sdnEntry', async (subtree) => {
    const record = mapEntryToRecord(subtree);
    if (!record) return;
    emitted++;
    await onRecord(record);
  });

  if (emitted === 0) {
    log.warn('stream.no_entries_found', { filePath });
  }
  log.info('stream.complete', { filePath, recordCount: emitted });
  return emitted;
}

/**
 * Array-returning form kept for existing callers and tests. Thin wrapper
 * over `parseUSListStreaming`, same relationship as `parseEUList` has to
 * `parseEUListStreaming`.
 */
export async function parseUSList(filePath: string): Promise<SanctionRecord[]> {
  const records: SanctionRecord[] = [];
  await parseUSListStreaming(filePath, (record) => {
    records.push(record);
  });
  return records;
}
