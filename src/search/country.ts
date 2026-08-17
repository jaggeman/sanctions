/**
 * Country & Nationality Normalization and Matching Engine (Issue #319).
 *
 * Provides normalized ISO-2 country resolution from full names, demonyms,
 * 3-letter codes, and multilingual country names (including Cyrillic/Ukrainian/Russian).
 *
 * Evaluates candidate sanction records against query nationality/country attributes
 * to award corroboration bonuses (+10) on matches and apply mismatch penalties (-20)
 * when explicit contradictory demographics exist.
 */

import { SanctionRecord } from '../shared/types';
import { normalizeText, transliterate } from '../importer/uploader';

// ---------------------------------------------------------------------------
// ISO-2 Country & Demonym Dictionary
// ---------------------------------------------------------------------------

const COUNTRY_MAP: Record<string, string> = {
  // Sweden & Nordics
  SE: 'SE', SWE: 'SE', SWEDEN: 'SE', SWEDISH: 'SE', SVERIGE: 'SE', SVENSK: 'SE', ШВЕЦІЯ: 'SE', ШВЕЦИЯ: 'SE',
  NO: 'NO', NOR: 'NO', NORWAY: 'NO', NORWEGIAN: 'NO', NORGE: 'NO', НОРВЕГІЯ: 'NO', НОРВЕГИЯ: 'NO',
  DK: 'DK', DNK: 'DK', DENMARK: 'DK', DANISH: 'DK', DANMARK: 'DK', ДАНІЯ: 'DK', ДАНИЯ: 'DK',
  FI: 'FI', FIN: 'FI', FINLAND: 'FI', FINNISH: 'FI', SUOMI: 'FI', ФІНЛЯНДІЯ: 'FI', ФИНЛЯНДИЯ: 'FI',
  IS: 'IS', ISL: 'IS', ICELAND: 'IS', ICELANDIC: 'IS', ISLAND: 'IS', ІСЛАНДІЯ: 'IS', ИСЛАНДИЯ: 'IS',

  // Russia & Post-Soviet
  RU: 'RU', RUS: 'RU', RUSSIA: 'RU', RUSSIAN: 'RU', RUSSIANFEDERATION: 'RU',
  РОСІЯ: 'RU', РОССИЯ: 'RU', РОССИЙСКАЯФЕДЕРАЦИЯ: 'RU', РОСІЙСЬКАФЕДЕРАЦІЯ: 'RU',
  UA: 'UA', UKR: 'UA', UKRAINE: 'UA', UKRAINIAN: 'UA', УКРАЇНА: 'UA', УКРАИНА: 'UA',
  BY: 'BY', BLR: 'BY', BELARUS: 'BY', BELARUSIAN: 'BY', БІЛОРУСЬ: 'BY', БЕЛАРУСЬ: 'BY',
  KZ: 'KZ', KAZ: 'KZ', KAZAKHSTAN: 'KZ', KAZAKHSTANI: 'KZ', KAZAKH: 'KZ', КАЗАХСТАН: 'KZ',
  UZ: 'UZ', UZB: 'UZ', UZBEKISTAN: 'UZ', UZBEK: 'UZ', УЗБЕКИСТАН: 'UZ',
  KG: 'KG', KGZ: 'KG', KYRGYZSTAN: 'KG', KYRGYZ: 'KG', КИРГИЗСТАН: 'KG',
  TJ: 'TJ', TJK: 'TJ', TAJIKISTAN: 'TJ', TAJIK: 'TJ', ТАДЖИКИСТАН: 'TJ',
  TM: 'TM', TKM: 'TM', TURKMENISTAN: 'TM', TURKMEN: 'TM', ТУРКМЕНИСТАН: 'TM',
  MD: 'MD', MDA: 'MD', MOLDOVA: 'MD', MOLDOVAN: 'MD', МОЛДОВА: 'MD',
  GE: 'GE', GEO: 'GE', GEORGIA: 'GE', GEORGIAN: 'GE', ГРУЗІЯ: 'GE', ГРУЗИЯ: 'GE',
  AM: 'AM', ARM: 'AM', ARMENIA: 'AM', ARMENIAN: 'AM', ВІРМЕНІЯ: 'AM', АРМЕНИЯ: 'AM',
  AZ: 'AZ', AZE: 'AZ', AZERBAIJAN: 'AZ', AZERBAIJANI: 'AZ', АЗЕРБАЙДЖАН: 'AZ',

  // Middle East & North Africa
  SY: 'SY', SYR: 'SY', SYRIA: 'SY', SYRIAN: 'SY', SYRIANARABREPUBLIC: 'SY', СИРІЯ: 'SY', СИРИЯ: 'SY',
  IR: 'IR', IRN: 'IR', IRAN: 'IR', IRANIAN: 'IR', ISLAMICREPUBLICOFIRAN: 'IR', ІРАН: 'IR',
  IQ: 'IQ', IRQ: 'IQ', IRAQ: 'IQ', IRAQI: 'IQ', ІРАК: 'IQ',
  IL: 'IL', ISR: 'IL', ISRAEL: 'IL', ISRAELI: 'IL', ІЗРАЇЛЬ: 'IL', ИЗРАИЛЬ: 'IL',
  PS: 'PS', PSE: 'PS', PALESTINE: 'PS', PALESTINIAN: 'PS', ПАЛЕСТИНА: 'PS',
  LB: 'LB', LBN: 'LB', LEBANON: 'LB', LEBANESE: 'LB', ЛІВАН: 'LB', ЛИВАН: 'LB',
  JO: 'JO', JOR: 'JO', JORDAN: 'JO', JORDANIAN: 'JO', ЙОРДАНІЯ: 'JO', ИОРДАНИЯ: 'JO',
  SA: 'SA', SAU: 'SA', SAUDIARABIA: 'SA', SAUDI: 'SA', САУДІВСЬКААРАВІЯ: 'SA', САУДОВСКАЯАРАВИЯ: 'SA',
  AE: 'AE', ARE: 'AE', UAE: 'AE', UNITEDARABEMIRATES: 'AE', EMIRATI: 'AE', ОАЕ: 'AE', ОАЭ: 'AE',
  QA: 'QA', QAT: 'QA', QATAR: 'QA', QATARI: 'QA', КАТАР: 'QA',
  KW: 'KW', KWT: 'KW', KUWAIT: 'KW', KUWAITI: 'KW', КУВЕЙТ: 'KW',
  BH: 'BH', BHR: 'BH', BAHRAIN: 'BH', BAHRAINI: 'BH', БАХРЕЙН: 'BH',
  OM: 'OM', OMN: 'OM', OMAN: 'OM', OMANI: 'OM', ОМАН: 'OM',
  YE: 'YE', YEM: 'YE', YEMEN: 'YE', YEMENI: 'YE', ЄМЕН: 'YE', ЙЕМЕН: 'YE',
  TR: 'TR', TUR: 'TR', TURKEY: 'TR', TURKIYE: 'TR', TURKISH: 'TR', ТУРЕЧЧИНА: 'TR', ТУРЦИЯ: 'TR',
  EG: 'EG', EGY: 'EG', EGYPT: 'EG', EGYPTIAN: 'EG', ЄГИПЕТ: 'EG', ЕГИПЕТ: 'EG',
  LY: 'LY', LBY: 'LY', LIBYA: 'LY', LIBYAN: 'LY', ЛІВІЯ: 'LY', ЛИВИЯ: 'LY',
  TN: 'TN', TUN: 'TN', TUNISIA: 'TN', TUNISIAN: 'TN', ТУНІС: 'TN', ТУНИС: 'TN',
  DZ: 'DZ', DZA: 'DZ', ALGERIA: 'DZ', ALGERIAN: 'DZ', АЛЖИР: 'DZ',
  MA: 'MA', MAR: 'MA', MOROCCO: 'MA', MOROCCAN: 'MA', МАРОККО: 'MA',
  SD: 'SD', SDN: 'SD', SUDAN: 'SD', SUDANESE: 'SD', СУДАН: 'SD',
  SS: 'SS', SSD: 'SS', SOUTHSUDAN: 'SS', SOUTHSUDANESE: 'SS', ПІВДЕННИЙСУДАН: 'SS', ЮЖНЫЙСУДАН: 'SS',
  SO: 'SO', SOM: 'SO', SOMALIA: 'SO', SOMALI: 'SO', СОМАЛІ: 'SO', СОМАЛИ: 'SO',

  // Americas
  US: 'US', USA: 'US', UNITEDSTATES: 'US', UNITEDSTATESOFAMERICA: 'US', AMERICAN: 'US', США: 'US',
  CA: 'CA', CAN: 'CA', CANADA: 'CA', CANADIAN: 'CA', КАНАДА: 'CA',
  MX: 'MX', MEX: 'MX', MEXICO: 'MX', MEXICAN: 'MX', МЕКСИКА: 'MX',
  CU: 'CU', CUB: 'CU', CUBA: 'CU', CUBAN: 'CU', КУБА: 'CU',
  VE: 'VE', VEN: 'VE', VENEZUELA: 'VE', VENEZUELAN: 'VE', ВЕНЕСУЕЛА: 'VE', ВЕНЕСУЭЛА: 'VE',
  CO: 'CO', COL: 'CO', COLOMBIA: 'CO', COLOMBIAN: 'CO', КОЛУМБІЯ: 'CO', КОЛУМБИЯ: 'CO',
  BR: 'BR', BRA: 'BR', BRAZIL: 'BR', BRAZILIAN: 'BR', БРАЗИЛІЯ: 'BR', БРАЗИЛИЯ: 'BR',
  AR: 'AR', ARG: 'AR', ARGENTINA: 'AR', ARGENTINE: 'AR', ARGENTINIAN: 'AR', АРГЕНТИНА: 'AR',
  CL: 'CL', CHL: 'CL', CHILE: 'CL', CHILEAN: 'CL', ЧИЛІ: 'CL', ЧИЛИ: 'CL',
  PE: 'PE', PER: 'PE', PERU: 'PE', PERUVIAN: 'PE', ПЕРУ: 'PE',
  NI: 'NI', NIC: 'NI', NICARAGUA: 'NI', NICARAGUAN: 'NI', НІКАРАГУА: 'NI', НИКАРАГУА: 'NI',
  HT: 'HT', HTI: 'HT', HAITI: 'HT', HAITIAN: 'HT', ГАЇТІ: 'HT', ГАИТИ: 'HT',
  PA: 'PA', PAN: 'PA', PANAMA: 'PA', PANAMANIAN: 'PA', ПАНАМА: 'PA',

  // Europe (EU & Non-EU)
  GB: 'GB', GBR: 'GB', UK: 'GB', UNITEDKINGDOM: 'GB', BRITISH: 'GB', GREATBRITAIN: 'GB', ВЕЛИКОБРИТАНІЯ: 'GB', ВЕЛИКОБРИТАНИЯ: 'GB',
  DE: 'DE', DEU: 'DE', GERMANY: 'DE', GERMAN: 'DE', DEUTSCHLAND: 'DE', НІМЕЧЧИНА: 'DE', ГЕРМАНИЯ: 'DE',
  FR: 'FR', FRA: 'FR', FRANCE: 'FR', FRENCH: 'FR', ФРАНЦІЯ: 'FR', ФРАНЦИЯ: 'FR',
  IT: 'IT', ITA: 'IT', ITALY: 'IT', ITALIAN: 'IT', ITALIA: 'IT', ІТАЛІЯ: 'IT', ИТАЛИЯ: 'IT',
  ES: 'ES', ESP: 'ES', SPAIN: 'ES', SPANISH: 'ES', ESPANA: 'ES', ІСПАНІЯ: 'ES', ИСПАНИЯ: 'ES',
  PT: 'PT', PRT: 'PT', PORTUGAL: 'PT', PORTUGUESE: 'PT', ПОРТУГАЛІЯ: 'PT', ПОРТУГАЛИЯ: 'PT',
  NL: 'NL', NLD: 'NL', NETHERLANDS: 'NL', DUTCH: 'NL', HOLLAND: 'NL', НІДЕРЛАНДИ: 'NL', НИДЕРЛАНДЫ: 'NL',
  BE: 'BE', BEL: 'BE', BELGIUM: 'BE', BELGIAN: 'BE', БЕЛЬГІЯ: 'BE', БЕЛЬГИЯ: 'BE',
  LU: 'LU', LUX: 'LU', LUXEMBOURG: 'LU', ЛЮКСЕМБУРГ: 'LU',
  CH: 'CH', CHE: 'CH', SWITZERLAND: 'CH', SWISS: 'CH', SCHWEIZ: 'CH', SUISSE: 'CH', ШВЕЙЦАРІЯ: 'CH', ШВЕЙЦАРИЯ: 'CH',
  AT: 'AT', AUT: 'AT', AUSTRIA: 'AT', AUSTRIAN: 'AT', OSTERREICH: 'AT', АВСТРІЯ: 'AT', АВСТРИЯ: 'AT',
  PL: 'PL', POL: 'PL', POLAND: 'PL', POLISH: 'PL', POLSKA: 'PL', ПОЛЬЩА: 'PL', ПОЛЬША: 'PL',
  CZ: 'CZ', CZE: 'CZ', CZECHIA: 'CZ', CZECHREPUBLIC: 'CZ', CZECH: 'CZ', ЧЕХІЯ: 'CZ', ЧЕХИЯ: 'CZ',
  SK: 'SK', SVK: 'SK', SLOVAKIA: 'SK', SLOVAK: 'SK', СЛОВАЧЧИНА: 'SK', СЛОВАКИЯ: 'SK',
  HU: 'HU', HUN: 'HU', HUNGARY: 'HU', HUNGARIAN: 'HU', УГОРЩИНА: 'HU', ВЕНГРИЯ: 'HU',
  RO: 'RO', ROU: 'RO', ROMANIA: 'RO', ROMANIAN: 'RO', РУМУНІЯ: 'RO', РУМЫНИЯ: 'RO',
  BG: 'BG', BGR: 'BG', BULGARIA: 'BG', BULGARIAN: 'BG', БОЛГАРІЯ: 'BG', БОЛГАРИЯ: 'BG',
  GR: 'GR', GRC: 'GR', GREECE: 'GR', GREEK: 'GR', ГРЕЦІЯ: 'GR', ГРЕЦИЯ: 'GR',
  CY: 'CY', CYP: 'CY', CYPRUS: 'CY', CYPRIOT: 'CY', КІПР: 'CY', КИПР: 'CY',
  MT: 'MT', MLT: 'MT', MALTA: 'MT', MALTESE: 'MT', МАЛЬТА: 'MT',
  IE: 'IE', IRL: 'IE', IRELAND: 'IE', IRISH: 'IE', ІРЛАНДІЯ: 'IE', ИРЛАНДИЯ: 'IE',
  EE: 'EE', EST: 'EE', ESTONIA: 'EE', ESTONIAN: 'EE', ЕСТОНІЯ: 'EE', ЭСТОНИЯ: 'EE',
  LV: 'LV', LVA: 'LV', LATVIA: 'LV', LATVIAN: 'LV', ЛАТВІЯ: 'LV', ЛАТВИЯ: 'LV',
  LT: 'LT', LTU: 'LT', LITHUANIA: 'LT', LITHUANIAN: 'LT', ЛИТВА: 'LT',
  RS: 'RS', SRB: 'RS', SERBIA: 'RS', SERBIAN: 'RS', СЕРБІЯ: 'RS', СЕРБИЯ: 'RS',
  BA: 'BA', BIH: 'BA', BOSNIA: 'BA', BOSNIAANDHERZEGOVINA: 'BA', BOSNIAN: 'BA', БОСНІЯ: 'BA', БОСНИЯ: 'BA',
  ME: 'ME', MNE: 'ME', MONTENEGRO: 'ME', MONTENEGRIN: 'ME', ЧОРНОГОРІЯ: 'ME', ЧЕРНОГОРИЯ: 'ME',
  MK: 'MK', MKD: 'MK', NORTHMACEDONIA: 'MK', MACEDONIA: 'MK', MACEDONIAN: 'MK', ПІВНІЧНАМАКЕДОНІЯ: 'MK', СЕВЕРНАЯМАКЕДОНИЯ: 'MK',
  AL: 'AL', ALB: 'AL', ALBANIA: 'AL', ALBANIAN: 'AL', АЛБАНІЯ: 'AL', АЛБАНИЯ: 'AL',
  XK: 'XK', XKS: 'XK', KOSOVO: 'XK', KOSOVAR: 'XK', КОСОВО: 'XK',

  // Asia & Pacific
  CN: 'CN', CHN: 'CN', CHINA: 'CN', CHINESE: 'CN', КИТАЙ: 'CN',
  KP: 'KP', PRK: 'KP', NORTHKOREA: 'KP', DEMOCRATICPEOPLESREPUBLICOFKOREA: 'KP', ПІВНІЧНАКОРЕЯ: 'KP', СЕВЕРНАЯКОРЕЯ: 'KP',
  KR: 'KR', KOR: 'KR', SOUTHKOREA: 'KR', REPUBLICOFKOREA: 'KR', KOREAN: 'KR', ПІВДЕННАКОРЕЯ: 'KR', ЮЖНАЯКОРЕЯ: 'KR',
  JP: 'JP', JPN: 'JP', JAPAN: 'JP', JAPANESE: 'JP', ЯПОНІЯ: 'JP', ЯПОНИЯ: 'JP',
  IN: 'IN', IND: 'IN', INDIA: 'IN', INDIAN: 'IN', ІНДІЯ: 'IN', ИНДИЯ: 'IN',
  PK: 'PK', PAK: 'PK', PAKISTAN: 'PK', PAKISTANI: 'PK', ПАКІСТАН: 'PK', ПАКИСТАН: 'PK',
  AF: 'AF', AFG: 'AF', AFGHANISTAN: 'AF', AFGHAN: 'AF', АФГАНІСТАН: 'AF', АФГАНИСТАН: 'AF',
  TW: 'TW', TWN: 'TW', TAIWAN: 'TW', TAIWANESE: 'TW', ТАЙВАНЬ: 'TW',
  HK: 'HK', HKG: 'HK', HONGKONG: 'HK', ГОНКОНГ: 'HK',
  SG: 'SG', SGP: 'SG', SINGAPORE: 'SG', SINGAPOREAN: 'SG', СІНГАПУР: 'SG', СИНГАПУР: 'SG',
  MY: 'MY', MYS: 'MY', MALAYSIA: 'MY', MALAYSIAN: 'MY', МАЛАЙЗІЯ: 'MY', МАЛАЙЗИЯ: 'MY',
  ID: 'ID', IDN: 'ID', INDONESIA: 'ID', INDONESIAN: 'ID', ІНДОНЕЗІЯ: 'ID', ИНДОНЕЗИЯ: 'ID',
  PH: 'PH', PHL: 'PH', PHILIPPINES: 'PH', FILIPINO: 'PH', ФІЛІППІНИ: 'PH', ФИЛИППИНЫ: 'PH',
  TH: 'TH', THA: 'TH', THAILAND: 'TH', THAI: 'TH', ТАЇЛАНД: 'TH', ТАИЛАНД: 'TH',
  VN: 'VN', VNM: 'VN', VIETNAM: 'VN', VIETNAMESE: 'VN', 'В\'ЄТНАМ': 'VN', ВЬЕТНАМ: 'VN',
  MM: 'MM', MMR: 'MM', MYANMAR: 'MM', BURMA: 'MM', BURMESE: 'MM', 'М\'ЯНМА': 'MM', МЬЯНМА: 'MM',
  AU: 'AU', AUS: 'AU', AUSTRALIA: 'AU', AUSTRALIAN: 'AU', АВСТРАЛІЯ: 'AU', АВСТРАЛИЯ: 'AU',
  NZ: 'NZ', NZL: 'NZ', NEWZEALAND: 'NZ', НОВАЗЕЛАНДІЯ: 'NZ', НОВАЯЗЕЛАНДИЯ: 'NZ',

  // Africa
  ZA: 'ZA', ZAF: 'ZA', SOUTHAFRICA: 'ZA', SOUTHAFRICAN: 'ZA', ПАР: 'ZA', ЮАР: 'ZA',
  NG: 'NG', NGA: 'NG', NIGERIA: 'NG', NIGERIAN: 'NG', НІГЕРІЯ: 'NG', НИГЕРИЯ: 'NG',
  KE: 'KE', KEN: 'KE', KENYA: 'KE', KENYAN: 'KE', КЕНІЯ: 'KE', КЕНИЯ: 'KE',
  ET: 'ET', ETH: 'ET', ETHIOPIA: 'ET', ETHIOPIAN: 'ET', ЕФІОПІЯ: 'ET', ЭФИОПИЯ: 'ET',
  CD: 'CD', COD: 'CD', DRC: 'CD', DEMOCRATICREPUBLICOFTHECONGO: 'CD', CONGO: 'CD', ДРКОНГО: 'CD',
  ZW: 'ZW', ZWE: 'ZW', ZIMBABWE: 'ZW', ZIMBABWEAN: 'ZW', ЗІМБАБВЕ: 'ZW', ЗИМБАБВЕ: 'ZW',
  ML: 'ML', MLI: 'ML', MALI: 'ML', MALIAN: 'ML', МАЛІ: 'ML', МАЛИ: 'ML',
  CF: 'CF', CAF: 'CF', CENTRALAFRICANREPUBLIC: 'CF', CAR: 'CF', ЦАР: 'CF',
};

/**
 * Normalizes any country name, nationality/demonym, or 2/3-letter ISO code
 * into an uppercase 2-letter ISO 3166-1 alpha-2 code. Returns null if invalid or empty.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-ZА-ЯЁІЇЄҐ0-9]/gu, '');

  if (!cleaned) return null;

  // Direct lookup
  if (COUNTRY_MAP[cleaned]) {
    return COUNTRY_MAP[cleaned];
  }

  // Transliterated lookup
  const translit = (transliterate(raw) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (translit && COUNTRY_MAP[translit]) {
    return COUNTRY_MAP[translit];
  }

  // If 2 ASCII letters, return directly as ISO-2 candidate
  if (/^[A-Z]{2}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Extracts the set of unique normalized 2-letter ISO country codes associated
 * with a candidate SanctionRecord across all demographic fields:
 * - citizenships
 * - addresses (country, countryIso2)
 * - identifications (countryIso2, issuedBy)
 * - placesOfBirth
 * - birthDates (countryIso2)
 */
export function extractRecordCountries(record: SanctionRecord): Set<string> {
  const result = new Set<string>();

  const add = (val?: string | null) => {
    const iso2 = normalizeCountry(val);
    if (iso2) result.add(iso2);
  };

  for (const c of record.citizenships ?? []) add(c);
  for (const a of record.addresses ?? []) {
    add(a.countryIso2);
    add(a.country);
  }
  for (const i of record.identifications ?? []) {
    add(i.countryIso2);
    add(i.issuedBy);
  }
  for (const pob of record.placesOfBirth ?? []) add(pob);
  for (const dob of record.birthDates ?? []) add(dob.countryIso2);

  return result;
}

export type CountryMatchStatus = 'no_query' | 'no_candidate_data' | 'match' | 'mismatch';

export interface CountryMatchResult {
  status: CountryMatchStatus;
  queryCountry?: string;
  candidateCountries: string[];
  boostApplied: boolean;
  penaltyApplied: boolean;
}

export const COUNTRY_MATCH_BOOST = 10;
export const COUNTRY_MISMATCH_PENALTY = 20;

/**
 * Compares a user-supplied nationality/country query against a candidate record.
 *
 * Rules:
 * - 'no_query': User did not provide a nationality or country filter (0 delta).
 * - 'no_candidate_data': Candidate record has no country metadata (0 delta, no penalty).
 * - 'match': Candidate lists at least one country matching query (+10 bonus).
 * - 'mismatch': Candidate lists 1+ countries, none match query (-20 penalty).
 */
export function evaluateCountryMatch(
  queryCountryOrNationality: string | null | undefined,
  record: SanctionRecord,
): CountryMatchResult {
  const queryIso2 = normalizeCountry(queryCountryOrNationality);
  if (!queryIso2) {
    return {
      status: 'no_query',
      candidateCountries: [],
      boostApplied: false,
      penaltyApplied: false,
    };
  }

  const candidateCountrySet = extractRecordCountries(record);
  const candidateCountries = Array.from(candidateCountrySet);

  if (candidateCountries.length === 0) {
    return {
      status: 'no_candidate_data',
      queryCountry: queryIso2,
      candidateCountries: [],
      boostApplied: false,
      penaltyApplied: false,
    };
  }

  const matches = candidateCountrySet.has(queryIso2);

  if (matches) {
    return {
      status: 'match',
      queryCountry: queryIso2,
      candidateCountries,
      boostApplied: true,
      penaltyApplied: false,
    };
  }

  return {
    status: 'mismatch',
    queryCountry: queryIso2,
    candidateCountries,
    boostApplied: false,
    penaltyApplied: true,
  };
}
