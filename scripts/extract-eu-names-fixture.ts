import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

async function main() {
  const xml = await fs.readFile('C:/Sanctions/lists/20260805-FULL-1_1(xsd).xml', 'utf-8');
  const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true, trimValues: true, removeNSPrefix: true });
  const parsed = parser.parse(xml);
  const entities = toArray(parsed.export?.sanctionEntity);
  console.log('Total sanctionEntity:', entities.length);

  const corpus: Array<{ id: string; primaryName: string; aliases: string[] }> = [];
  for (const e of entities) {
    const logicalId = e['@_logicalId'];
    if (!logicalId) continue;
    const aliases = toArray(e.nameAlias);
    let primary = '';
    const aliasNames: string[] = [];
    for (const a of aliases) {
      const whole = a['@_wholeName'] || `${a['@_firstName'] || ''} ${a['@_lastName'] || ''}`.trim();
      if (!whole) continue;
      if (a['@_primary'] === true && !primary) primary = whole;
      else aliasNames.push(whole);
    }
    if (!primary && aliasNames.length > 0) primary = aliasNames.shift()!;
    if (!primary) continue;
    corpus.push({ id: `EU-${logicalId}`, primaryName: primary, aliases: aliasNames });
  }

  console.log('Corpus size:', corpus.length);
  const qusay = corpus.find((c) => c.id === 'EU-20');
  console.log('EU-20 (real, direct extraction):', JSON.stringify(qusay));

  await fs.writeJson('tests/fixtures/real-eu-names-corpus.json', corpus);
  console.log('Wrote tests/fixtures/real-eu-names-corpus.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
