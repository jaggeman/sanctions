import {
  SanctionRecord,
  Address,
  Identification,
  NameAlias,
  BirthDate,
  SanctionType,
  RecordStatus,
} from '../../shared/types';
import { streamXmlRecords } from './xmlSubtreeStream';
import { normalizeText } from '../uploader';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.ch' });

/**
 * Parser for the Switzerland State Secretariat for Economic Affairs (SECO)
 * sanctions list, issue #140.
 *
 * Streamed via `streamXmlRecords` to keep memory consumption well below
 * the 256 MiB cloud budget for the ~40 MB XML export.
 *
 * Reference: https://www.sesam.search.admin.ch
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function str(val: any): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') {
    if (val['#text'] !== undefined) return String(val['#text']).trim();
    if (val.value !== undefined) return String(val.value).trim();
  }
  return String(val).trim();
}

// issue #283: a target can have more than one sibling <justification> (or
// <other-information>) element — fast-xml-parser then returns an array of
// nodes instead of a single one. str() only extracts a single node's text;
// falling through to String(array) joined each element via its own default
// Object.prototype.toString(), producing the literal garbage
// "[object Object],[object Object]" in production (CH-52941). toArray()
// normalizes the single-or-array shape uniformly; str() already extracts
// each individual node's text correctly.
function joinTextNodes(val: any, separator = '; '): string {
  return toArray(val).map(str).filter(Boolean).join(separator);
}

function parseNum(val: any): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = parseInt(String(val).trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

const SAFE_SSID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export async function parseChXmlStream(
  filePath: string,
  onRecord: (record: SanctionRecord) => Promise<void> | void,
): Promise<{ count: number }> {
  let count = 0;

  await streamXmlRecords(filePath, 'target', async (target) => {
    const rawSsid = str(target['@_ssid'] || target.ssid);
    if (!rawSsid || !SAFE_SSID_PATTERN.test(rawSsid)) {
      log.warn('Skipping target with missing or invalid ssid', { ssid: rawSsid });
      return;
    }

    const id = `CH-${rawSsid}`;

    // Determine target type
    let type: SanctionType = 'entity';
    let targetNode: any = null;

    if (target.individual) {
      type = 'individual';
      targetNode = target.individual;
    } else if (target.entity) {
      type = 'entity';
      targetNode = target.entity;
    } else if (target.object) {
      targetNode = target.object;
      const objType = str(target.object['@_object-type'] || target.object['object-type']).toLowerCase();
      if (objType === 'vessel') {
        type = 'vessel';
      } else if (objType === 'aircraft') {
        type = 'aircraft';
      } else {
        type = 'entity';
      }
    }

    if (!targetNode) {
      log.warn('Target node has no individual/entity/object body', { id });
      return;
    }

    // Modifications / Delisting
    const modifications = toArray(target.modification);
    let status: RecordStatus = 'active';
    let delistedAt: string | undefined;
    let listedAt: string | undefined;

    for (const mod of modifications) {
      const modType = str(mod['@_modification-type'] || mod['modification-type']).toLowerCase();
      if (modType === 'de-listed') {
        status = 'delisted';
        delistedAt = str(mod['@_effective-date'] || mod['@_publication-date'] || mod['@_enactment-date']) || undefined;
      } else if (modType === 'listed') {
        const date = str(mod['@_effective-date'] || mod['@_publication-date'] || mod['@_enactment-date']);
        if (date) listedAt = date;
      }
    }

    // Names & aliases
    const names: NameAlias[] = [];
    const seenNames = new Set<string>();
    const searchVariants: string[] = [];

    const identities = toArray(targetNode.identity);
    for (const identity of identities) {
      const nameNodes = toArray(identity.name);
      for (const nameNode of nameNodes) {
        const nameType = str(nameNode['@_name-type'] || nameNode['name-type']).toLowerCase();
        const isPrimary = nameType === 'primary-name';
        const quality = str(nameNode['@_quality'] || nameNode.quality).toLowerCase();
        const strong = quality !== 'low'; // CLAUDE.md §6 reliability flag
        const lang = str(nameNode['@_lang'] || nameNode.lang) || undefined;

        const nameParts = toArray(nameNode['name-part']).sort((a, b) => {
          const orderA = parseNum(a['@_order'] || a.order) ?? 1;
          const orderB = parseNum(b['@_order'] || b.order) ?? 1;
          return orderA - orderB;
        });

        const wholeNameParts: string[] = [];
        const variantPartsByKey: Record<string, string[]> = {};

        for (const part of nameParts) {
          const val = str(part.value || part['#text'] || (typeof part === 'string' ? part : ''));
          if (val) wholeNameParts.push(val);

          const variants = toArray(part['spelling-variant']);
          for (const v of variants) {
            const vText = str(v['#text'] || v.value || (typeof v === 'string' ? v : ''));
            if (vText) {
              searchVariants.push(vText);
              const langKey = str(v['@_lang'] || v.lang || 'unk');
              const scriptKey = str(v['@_script'] || v.script || 'unk');
              const key = `${langKey}_${scriptKey}`;
              if (!variantPartsByKey[key]) variantPartsByKey[key] = [];
              variantPartsByKey[key].push(vText);
            }
          }
        }

        const wholeName = wholeNameParts.join(' ').trim();
        if (wholeName && !seenNames.has(wholeName)) {
          seenNames.add(wholeName);
          if (isPrimary && names.length === 0) {
            names.unshift({ wholeName, strong, language: lang });
          } else {
            names.push({ wholeName, strong, language: lang });
          }
        }

        // Add assembled whole-name spelling variants as aliases
        for (const [_, vParts] of Object.entries(variantPartsByKey)) {
          const variantFullName = vParts.join(' ').trim();
          if (variantFullName && !seenNames.has(variantFullName)) {
            seenNames.add(variantFullName);
            names.push({ wholeName: variantFullName, strong, language: lang });
          }
        }
      }
    }

    // Fallback name if none found
    if (names.length === 0) {
      names.push({ wholeName: `Target ${rawSsid}`, strong: false });
    }

    // Birth dates
    const birthDates: BirthDate[] = [];
    for (const identity of identities) {
      const dmyNodes = toArray(identity['day-month-year']);
      for (const dmy of dmyNodes) {
        const day = parseNum(dmy['@_day'] || dmy.day);
        const month = parseNum(dmy['@_month'] || dmy.month);
        const year = parseNum(dmy['@_year'] || dmy.year);
        const circa = str(dmy['@_circa'] || dmy.circa) === 'true';

        let raw: string | undefined;
        if (year && month && day) {
          raw = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        } else if (year) {
          raw = String(year);
        }

        if (year || raw) {
          birthDates.push({
            year,
            month,
            day,
            circa: circa ? true : undefined,
            raw,
          });
        }
      }
    }

    // Identifications
    const identifications: Identification[] = [];
    for (const identity of identities) {
      const idDocs = toArray(identity['identification-document']);
      for (const doc of idDocs) {
        const number = str(doc.number || doc['#text'] || doc['@_number']);
        if (!number) continue;

        const docType = str(doc['@_document-type'] || doc['document-type'] || doc.type);
        const issuer = str(doc.issuer || doc['@_issuer']);
        const country = str(doc.country || doc['@_country'] || doc['country-iso2-code']);

        identifications.push({
          number,
          typeDescription: docType || undefined,
          issuedBy: issuer || undefined,
          countryIso2: country || undefined,
        });
      }
    }

    // Addresses
    const addresses: Address[] = [];
    for (const identity of identities) {
      const addrNodes = toArray(identity.address);
      for (const addr of addrNodes) {
        const details = str(addr['address-details'] || addr.details);
        const street = str(addr.street);
        const poBox = str(addr['p-o-box'] || addr.pobox);
        const zipCode = str(addr['zip-code'] || addr.zipCode);
        const city = str(addr.city || addr.place);
        const country = str(addr.country || addr['country-iso2-code']);

        if (details || street || poBox || zipCode || city || country) {
          addresses.push({
            street: street || undefined,
            city: city || undefined,
            poBox: poBox || undefined,
            region: zipCode || undefined,
            country: country || undefined,
            fullAddress: [details, street, poBox, zipCode, city, country].filter(Boolean).join(', ') || undefined,
          });
        }
      }
    }

    // Justification / legal basis. Prefers justification over
    // other-information, same as before — other-information is only used
    // when there's no justification at all.
    const justification =
      joinTextNodes(targetNode.justification) || joinTextNodes(targetNode['other-information']);

    // Search names
    const searchNamesSet = new Set<string>();
    for (const name of names) {
      const norm = normalizeText(name.wholeName);
      if (norm) searchNamesSet.add(norm);
    }
    for (const v of searchVariants) {
      const norm = normalizeText(v);
      if (norm) searchNamesSet.add(norm);
    }

    const now = new Date().toISOString();
    const record: SanctionRecord = {
      id,
      source: 'CH',
      type,
      names,
      searchNames: Array.from(searchNamesSet),
      birthDates: birthDates.length > 0 ? birthDates : undefined,
      identifications: identifications.length > 0 ? identifications : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: justification || undefined,
      status,
      delistedAt,
      listedAt,
      createdAt: listedAt || now,
      updatedAt: now,
    };

    await onRecord(record);
    count++;
  });

  return { count };
}

/**
 * Array-returning form kept for callers and tests.
 */
export async function parseChXml(filePath: string): Promise<SanctionRecord[]> {
  const records: SanctionRecord[] = [];
  await parseChXmlStream(filePath, (record) => {
    records.push(record);
  });
  return records;
}
