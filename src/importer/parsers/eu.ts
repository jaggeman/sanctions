import * as sax from 'sax';
import * as fs from 'fs-extra';
import { SanctionRecord, Address, Identification, Regulation, NameAlias, BirthDate, ContactInfo } from '../../shared/types';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.eu' });

/**
 * Parser for the EU Financial Sanctions Database (FSD) consolidated export,
 * schema version 1.1.
 *
 * The one thing to know before editing: in this format essentially all the data
 * lives in XML *attributes*, not child elements. A `<nameAlias>` carries
 * `wholeName="..."` as an attribute; there is no `<wholeName>` child. Reading it
 * as an element silently yields `undefined` rather than throwing, which is how
 * this parser previously produced 6 234 nameless records from a valid file.
 *
 * Parsing is SAX-based (issue #5): the real export is ~25 MB of XML which,
 * built as a single DOM tree (the previous approach, via fast-xml-parser's
 * `XMLParser`), multiplied out to well over 100 MB of live objects — more than
 * the deployed Cloud Function's memory budget. `parseEUListStreaming` below
 * builds one `<sanctionEntity>` subtree at a time, maps it to a `SanctionRecord`,
 * hands it to the caller, and discards it before moving to the next one. The
 * rest of this file (`SAFE_LOGICAL_ID`, `collectAliases`, `selectPrimary`, etc.)
 * is unchanged field-mapping logic, now running per-entity instead of over a
 * fully-materialised document.
 *
 * Reference sample: tests/fixtures/eu_sample.xml (carved from the real export).
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/** Read `name` from a node, preferring the attribute form and falling back to a child element. */
function attr(node: any, name: string): string {
  if (!node) return '';
  const raw = node[`@_${name}`] ?? node[name];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

function bool(node: any, name: string): boolean {
  const raw = attr(node, name).toLowerCase();
  return raw === 'true' || raw === '1';
}

/** Read an integer attribute, or undefined if absent/not a valid number. */
function int(node: any, name: string): number | undefined {
  const raw = attr(node, name);
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * The source uses '-' and 'UNKNOWN' as placeholders for "not stated".
 * Treat them as absent rather than rendering them to users.
 */
const PLACEHOLDERS = new Set(['', '-', '--', 'unknown']);
function meaningful(value: string): string {
  return PLACEHOLDERS.has(value.toLowerCase()) ? '' : value;
}

/**
 * Country fields additionally use the ISO code '00' for unknown. Kept separate
 * from `meaningful` so a legitimate '00' elsewhere (a postcode, a document
 * number) is not silently dropped.
 */
function meaningfulCountry(value: string): string {
  return value === '00' ? '' : meaningful(value);
}

/**
 * `logicalId` becomes a Firestore document ID. It arrives from a user-uploaded
 * file, so it is validated rather than trusted: a value containing '/' would
 * otherwise turn `EU-<id>` into a nested collection path.
 */
const SAFE_LOGICAL_ID = /^[A-Za-z0-9._-]{1,200}$/;

interface AliasCandidate {
  wholeName: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  language?: string;
  title?: string;
  function?: string;
  hasNameParts: boolean;
  isStrong: boolean;
  isPreferredLanguage: boolean;
}

/** Language tags treated as the canonical rendering of a name. */
const PREFERRED_LANGUAGES = new Set(['', 'en']);

function collectAliases(entry: any): AliasCandidate[] {
  const seen = new Set<string>();
  const candidates: AliasCandidate[] = [];

  for (const node of toArray(entry.nameAlias)) {
    const whole = attr(node, 'wholeName');
    const first = attr(node, 'firstName');
    const middle = attr(node, 'middleName');
    const last = attr(node, 'lastName');

    const wholeName = whole || [first, middle, last].filter(Boolean).join(' ').trim();
    if (!wholeName || seen.has(wholeName)) continue;
    seen.add(wholeName);

    const language = meaningful(attr(node, 'nameLanguage')) || undefined;

    candidates.push({
      wholeName,
      firstName: meaningful(first) || undefined,
      middleName: meaningful(middle) || undefined,
      lastName: meaningful(last) || undefined,
      language,
      title: meaningful(attr(node, 'title')) || undefined,
      function: meaningful(attr(node, 'function')) || undefined,
      // A structured first/last pair marks the canonical designation rather than
      // a transliteration, which is the most reliable primary-name signal here.
      hasNameParts: Boolean(first && last),
      isStrong: bool(node, 'strong'),
      isPreferredLanguage: PREFERRED_LANGUAGES.has(attr(node, 'nameLanguage').toLowerCase()),
    });
  }

  return candidates;
}

/**
 * Pick the primary name deterministically.
 *
 * There is no `primary` attribute in this schema, so selection is by successive
 * narrowing: strong names, then those with structured name parts, then those in
 * a preferred language. Each filter is skipped when it would eliminate every
 * remaining candidate. Document order breaks the final tie, so the same input
 * always yields the same primary name.
 */
function selectPrimary(candidates: AliasCandidate[]): number {
  let pool = candidates.map((_, i) => i);

  const narrow = (predicate: (c: AliasCandidate) => boolean) => {
    const next = pool.filter((i) => predicate(candidates[i]));
    if (next.length > 0) pool = next;
  };

  narrow((c) => c.isStrong);
  narrow((c) => c.hasNameParts);
  narrow((c) => c.isPreferredLanguage);

  return pool[0];
}

function parseAddresses(entry: any): Address[] {
  const addresses: Address[] = [];

  for (const node of toArray(entry.address)) {
    const street = meaningful(attr(node, 'street'));
    const city = meaningful(attr(node, 'city'));
    const zip = meaningful(attr(node, 'zipCode'));
    const poBox = meaningful(attr(node, 'poBox'));
    const region = meaningful(attr(node, 'region'));
    const place = meaningful(attr(node, 'place'));
    const countryIso2 = meaningfulCountry(attr(node, 'countryIso2Code'));
    const country = meaningfulCountry(attr(node, 'countryDescription')) || countryIso2;

    const fullAddress = [street, poBox, place, city, region, zip, country]
      .filter(Boolean)
      .join(', ');

    // The export contains address nodes whose every field is empty. Emitting an
    // object of undefineds for those just adds noise to the record.
    if (!fullAddress) continue;

    addresses.push({
      street: street || undefined,
      city: city || undefined,
      country: country || undefined,
      fullAddress,
      poBox: poBox || undefined,
      region: region || undefined,
      place: place || undefined,
      countryIso2: countryIso2 || undefined,
    });
  }

  return addresses;
}

/**
 * Structured, precision-aware birth dates (issue #6) — the source
 * distinguishes an exact date from a year-only value, a year range, and
 * `circa`, none of which survive the flat `datesOfBirth: string[]` below.
 */
function parseBirthDateObjects(entry: any): BirthDate[] {
  const out: BirthDate[] = [];

  for (const node of toArray(entry.birthdate)) {
    const raw = meaningful(attr(node, 'birthdate')) || undefined;
    const year = int(node, 'year');
    const month = int(node, 'monthOfYear');
    const day = int(node, 'dayOfMonth');
    const yearRangeFrom = int(node, 'yearRangeFrom');
    const yearRangeTo = int(node, 'yearRangeTo');
    const circa = bool(node, 'circa');
    const city = meaningful(attr(node, 'city')) || undefined;
    const place = meaningful(attr(node, 'place')) || undefined;
    const countryIso2 = meaningfulCountry(attr(node, 'countryIso2Code')) || undefined;

    if (!raw && year === undefined && yearRangeFrom === undefined && !city && !place) continue;

    out.push({ raw, year, month, day, yearRangeFrom, yearRangeTo, circa, city, place, countryIso2 });
  }

  return out;
}

/** Legacy flat form derived from the structured birth dates above. */
function deriveDatesOfBirth(birthDates: BirthDate[]): string[] {
  const dates: string[] = [];
  for (const b of birthDates) {
    const date = b.raw || (b.year !== undefined ? String(b.year) : undefined);
    if (date && !dates.includes(date)) dates.push(date);
  }
  return dates;
}

function parsePlacesOfBirth(entry: any): string[] {
  const places: string[] = [];

  for (const node of toArray(entry.birthdate)) {
    const city = meaningful(attr(node, 'city'));
    const place = meaningful(attr(node, 'place'));
    const region = meaningful(attr(node, 'region'));
    const country =
      meaningfulCountry(attr(node, 'countryDescription')) || meaningfulCountry(attr(node, 'countryIso2Code'));

    const pob = [city, place, region, country].filter(Boolean).join(', ');
    if (pob && !places.includes(pob)) places.push(pob);
  }

  return places;
}

/** Structured identifications (issue #6) — type, country and reliability flags, not a formatted string. */
function parseIdentificationObjects(entry: any): Identification[] {
  const out: Identification[] = [];

  for (const node of toArray(entry.identification)) {
    const number = meaningful(attr(node, 'number')) || meaningful(attr(node, 'latinNumber'));
    if (!number) continue;

    out.push({
      number,
      typeCode: meaningful(attr(node, 'identificationTypeCode')) || undefined,
      typeDescription: meaningful(attr(node, 'identificationTypeDescription')) || undefined,
      countryIso2: meaningfulCountry(attr(node, 'countryIso2Code')) || undefined,
      issuedBy: meaningful(attr(node, 'issuedBy')) || undefined,
      knownFalse: bool(node, 'knownFalse'),
      knownExpired: bool(node, 'knownExpired'),
      reportedLost: bool(node, 'reportedLost'),
      revokedByIssuer: bool(node, 'revokedByIssuer'),
      diplomatic: bool(node, 'diplomatic'),
    });
  }

  return out;
}

/** Legacy flat form derived from the structured identifications above. */
function derivePassports(identifications: Identification[]): string[] {
  const out: string[] = [];

  for (const id of identifications) {
    const description = id.typeDescription || id.typeCode;
    const country = meaningfulCountry(id.countryIso2 || '');

    const caveats = [
      id.knownFalse && 'known false',
      id.knownExpired && 'expired',
      id.reportedLost && 'reported lost',
      id.revokedByIssuer && 'revoked',
    ].filter(Boolean) as string[];

    let entryText = description ? `${description} ${id.number}` : id.number;
    if (country) entryText += ` (${country})`;
    if (caveats.length > 0) entryText += ` [${caveats.join(', ')}]`;

    if (!out.includes(entryText)) out.push(entryText);
  }

  return out;
}

/** The legal basis for a listing (issue #6) — `<regulation>`, falling back to `<regulationSummary>`. */
function parseRegulation(entry: any): Regulation | undefined {
  const node = entry.regulation || entry.regulationSummary;
  if (!node) return undefined;

  const numberTitle = meaningful(attr(node, 'numberTitle')) || undefined;
  const programme = meaningful(attr(node, 'programme')) || undefined;
  const publicationDate = meaningful(attr(node, 'publicationDate')) || undefined;
  const entryIntoForceDate = meaningful(attr(node, 'entryIntoForceDate')) || undefined;
  const url = meaningful(attr(node, 'publicationUrl')) || undefined;

  if (!numberTitle && !programme && !publicationDate && !entryIntoForceDate && !url) return undefined;
  return { numberTitle, programme, publicationDate, entryIntoForceDate, url };
}

/**
 * `<contactInfo>` (issue #6) appears nested under `<address>` in the real
 * export, never directly under the entity — aggregated here across every
 * address the entity has, deduplicated per key.
 */
function parseContactInfo(entry: any): ContactInfo | undefined {
  const phoneNumbers: string[] = [];
  const faxNumbers: string[] = [];
  const emails: string[] = [];
  const websites: string[] = [];

  for (const addressNode of toArray(entry.address)) {
    for (const node of toArray(addressNode.contactInfo)) {
      const key = attr(node, 'key').toUpperCase();
      const value = meaningful(attr(node, 'value'));
      if (!value) continue;

      const bucket =
        key === 'PHONE' ? phoneNumbers : key === 'FAX' ? faxNumbers : key === 'EMAIL' ? emails : key === 'WEB' ? websites : null;
      if (bucket && !bucket.includes(value)) bucket.push(value);
    }
  }

  if (!phoneNumbers.length && !faxNumbers.length && !emails.length && !websites.length) return undefined;

  return {
    phoneNumbers: phoneNumbers.length > 0 ? phoneNumbers : undefined,
    faxNumbers: faxNumbers.length > 0 ? faxNumbers : undefined,
    emails: emails.length > 0 ? emails : undefined,
    websites: websites.length > 0 ? websites : undefined,
  };
}

/**
 * Map one already-built `<sanctionEntity>` subtree (attribute-prefixed, in the
 * same shape fast-xml-parser used to produce for the whole document) to a
 * `SanctionRecord`. Returns null for an entity that should be skipped
 * (missing or unsafe `logicalId`).
 *
 * Deliberately does not keep a `rawSourceData` reference to `entry` — every
 * record used to carry the entire parsed source node inline, which was the
 * second-largest contributor (after the DOM tree itself) to peak import
 * memory for no read-path benefit today.
 */
function mapEntityToRecord(entry: any): SanctionRecord | null {
  const logicalId = attr(entry, 'logicalId');
  if (!logicalId) return null;
  if (!SAFE_LOGICAL_ID.test(logicalId)) {
    log.warn('entity.skipped_unsafe_logical_id', { logicalId });
    return null;
  }

  // subjectType is code="person" | "enterprise" (classificationCode P | E).
  const subjectCode = attr(entry.subjectType, 'code').toLowerCase();
  const classification = attr(entry.subjectType, 'classificationCode').toUpperCase();
  const isPerson = subjectCode === 'person' || (!subjectCode && classification === 'P');
  const type: SanctionRecord['type'] = isPerson ? 'individual' : 'entity';

  const candidates = collectAliases(entry);
  let primaryName = 'Unknown Name';
  let aliases: string[] = [];

  if (candidates.length > 0) {
    const primaryIndex = selectPrimary(candidates);
    primaryName = candidates[primaryIndex].wholeName;
    aliases = candidates.filter((_, i) => i !== primaryIndex).map((c) => c.wholeName);
  }
  const names: NameAlias[] = candidates.map((c) => ({
    wholeName: c.wholeName,
    firstName: c.firstName,
    middleName: c.middleName,
    lastName: c.lastName,
    strong: c.isStrong,
    language: c.language,
    title: c.title,
    function: c.function,
  }));

  const addresses = parseAddresses(entry);
  const birthDates = parseBirthDateObjects(entry);
  const datesOfBirth = deriveDatesOfBirth(birthDates);
  const placesOfBirth = parsePlacesOfBirth(entry);
  const identifications = parseIdentificationObjects(entry);
  const passports = derivePassports(identifications);
  const regulation = parseRegulation(entry);
  const contactInfo = parseContactInfo(entry);

  const citizenships: string[] = [];
  for (const node of toArray(entry.citizenship)) {
    const country =
      meaningfulCountry(attr(node, 'countryDescription')) || meaningfulCountry(attr(node, 'countryIso2Code'));
    if (country && !citizenships.includes(country)) citizenships.push(country);
  }

  const now = new Date().toISOString();

  return {
    id: `EU-${logicalId}`,
    source: 'EU',
    type,
    primaryName,
    aliases,
    searchNames: [], // Generated by uploader
    datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
    placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
    citizenships: citizenships.length > 0 ? citizenships : undefined,
    passports: passports.length > 0 ? passports : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    sanctionReason: regulation?.numberTitle,
    legalBasis: regulation?.url,
    euReferenceNumber: meaningful(attr(entry, 'euReferenceNumber')) || undefined,
    unitedNationId: meaningful(attr(entry, 'unitedNationId')) || undefined,
    sourceRef: logicalId,
    identifications: identifications.length > 0 ? identifications : undefined,
    regulation,
    names: names.length > 0 ? names : undefined,
    birthDates: birthDates.length > 0 ? birthDates : undefined,
    contactInfo,
    createdAt: now,
    updatedAt: now,
  };
}

function stripPrefix(name: string): string {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function pushChild(parent: Record<string, any>, tagName: string, child: any) {
  const existing = parent[tagName];
  if (existing === undefined) {
    parent[tagName] = child;
  } else if (Array.isArray(existing)) {
    existing.push(child);
  } else {
    parent[tagName] = [existing, child];
  }
}

interface Frame {
  tagName: string;
  node: Record<string, any>;
  text: string;
  childCount: number;
}

/**
 * Stream-parse the EU FSD export, invoking `onRecord` once per
 * `<sanctionEntity>` as soon as its closing tag is seen. Only one entity's
 * subtree — a few dozen small objects — is ever held in memory at a time; the
 * rest of the (multi-megabyte) document is never materialised as a tree.
 *
 * `onRecord` may return a Promise; when it does, parsing pauses on the
 * underlying file stream until it resolves. This lets a caller batch records
 * and await a Firestore write without the parser racing arbitrarily far ahead
 * of what has actually been persisted.
 *
 * Resolves to the number of `sanctionEntity` nodes for which `onRecord` was
 * actually invoked (entities skipped for a missing/unsafe `logicalId` are not
 * counted).
 */
export async function parseEUListStreaming(
  filePath: string,
  onRecord: (record: SanctionRecord) => void | Promise<void>,
): Promise<number> {
  log.info('stream.start', { filePath });

  return new Promise((resolve, reject) => {
    const parserStream = sax.createStream(true, { trim: false, lowercase: false });
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' });

    const stack: Frame[] = [];
    let depth = 0;
    let entityDepth = -1;
    let emitted = 0;
    let settled = false;
    const pending: Promise<void>[] = [];
    // issue #171: a single read chunk can yield several closetag events
    // synchronously, so more than one onRecord call can be outstanding at
    // once. pause()/resume() is a binary switch, not a counter — resuming as
    // soon as the FIRST of several outstanding promises settles lets the
    // stream race ahead of a still-in-flight flush. Only resume once every
    // currently-outstanding promise has settled.
    let outstanding = 0;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      reject(err);
    };

    parserStream.on('opentag', (node: sax.Tag) => {
      depth++;
      const tagName = stripPrefix(node.name);
      const obj: Record<string, any> = {};
      for (const [rawAttrName, rawVal] of Object.entries(node.attributes)) {
        obj[`@_${stripPrefix(rawAttrName)}`] = String(rawVal).trim();
      }
      stack.push({ tagName, node: obj, text: '', childCount: 0 });

      if (tagName === 'sanctionEntity' && entityDepth === -1) {
        entityDepth = depth;
      }
    });

    parserStream.on('text', (t: string) => {
      if (stack.length > 0) stack[stack.length - 1].text += t;
    });

    parserStream.on('closetag', (rawName: string) => {
      const tagName = stripPrefix(rawName);
      const frame = stack.pop();
      depth--;
      if (!frame) return;

      const hasAttrs = Object.keys(frame.node).length > 0;
      const value: any = !hasAttrs && frame.childCount === 0 ? frame.text.trim() : frame.node;

      if (stack.length === 0) return; // closed the document root itself

      if (tagName === 'sanctionEntity' && depth + 1 === entityDepth) {
        entityDepth = -1;

        let record: SanctionRecord | null;
        try {
          record = mapEntityToRecord(value);
        } catch (err) {
          fail(err as Error);
          return;
        }

        if (record) {
          emitted++;
          let result: void | Promise<void>;
          try {
            result = onRecord(record);
          } catch (err) {
            fail(err as Error);
            return;
          }
          if (result && typeof (result as Promise<void>).then === 'function') {
            readStream.pause();
            outstanding++;
            const awaited = (result as Promise<void>).then(
              () => {
                outstanding--;
                if (outstanding === 0) readStream.resume();
              },
              (err) => {
                outstanding--;
                fail(err);
                throw err;
              },
            );
            pending.push(awaited);
          }
        }
        return; // never attached to the parent — nothing to hold onto
      }

      const parent = stack[stack.length - 1];
      parent.childCount++;
      pushChild(parent.node, tagName, value);
    });

    parserStream.on('error', (err: Error) => {
      // sax keeps running after emitting 'error' unless the stream is torn down.
      fail(err);
    });

    readStream.on('error', (err) => fail(err));

    parserStream.on('end', () => {
      // All onRecord invocations already happened synchronously by this point;
      // this only waits for any async ones (chunk flushes, uploads, ...) to
      // actually finish before reporting the parse as done.
      Promise.all(pending).then(() => {
        if (settled) return;
        settled = true;
        if (emitted === 0) {
          log.warn('stream.no_entities_found', { filePath });
        }
        log.info('stream.complete', { filePath, entityCount: emitted });
        resolve(emitted);
      }, fail);
    });

    readStream.pipe(parserStream as unknown as NodeJS.WritableStream);
  });
}

/**
 * Array-returning form kept for existing callers and tests. Thin wrapper over
 * `parseEUListStreaming` — still avoids the full-DOM-tree memory cost, it just
 * also holds every mapped (small, `rawSourceData`-free) record in an array
 * for the duration of the call, same as before.
 */
export async function parseEUList(filePath: string): Promise<SanctionRecord[]> {
  const records: SanctionRecord[] = [];
  await parseEUListStreaming(filePath, (record) => {
    records.push(record);
  });
  log.info('parse.complete', { filePath, recordCount: records.length });
  return records;
}
