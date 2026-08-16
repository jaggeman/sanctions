import * as path from 'path';
import * as fs from 'fs-extra';
import { parseEUListStreaming } from '../src/importer/parsers/eu';
import { parseUNList } from '../src/importer/parsers/un';
import { parseUSListStreaming } from '../src/importer/parsers/us';
import { parseUKListStreaming } from '../src/importer/parsers/uk';
import { parseChXmlStream } from '../src/importer/parsers/ch';
import { startDiffSession } from '../src/importer/diff';
import { invalidateSearchIndex } from '../src/search';
import { SanctionRecord } from '../src/shared/types';

async function importAll() {
  console.log('🚀 Startar import av alla lokala sanktionslistor till Firestore...\n');

  const files = [
    {
      source: 'UN' as const,
      path: path.resolve(__dirname, '../downloads/un_sanctions.xml'),
      parser: 'un',
    },
    {
      source: 'UK' as const,
      path: path.resolve(__dirname, '../lists/uk_sanctions.xml'),
      parser: 'uk',
    },
    {
      source: 'EU' as const,
      path: path.resolve(__dirname, '../lists/20260805-FULL-1_1(xsd).xml'),
      parser: 'eu',
    },
    {
      source: 'US' as const,
      path: path.resolve(__dirname, '../downloads/us_sdn.xml'),
      parser: 'us',
    },
    {
      source: 'CH' as const,
      path: path.resolve(__dirname, '../downloads/ch_sanctions.xml'),
      parser: 'ch',
    },
  ];

  for (const item of files) {
    if (!fs.existsSync(item.path)) {
      console.warn(`⚠️ Fil saknas för ${item.source}: ${item.path}, hoppar över.`);
      continue;
    }

    console.log(`\n========================================`);
    console.log(`📦 Importerar ${item.source} från: ${path.basename(item.path)}`);
    console.log(`========================================`);

    const session = await startDiffSession(item.source, { mode: 'append' });
    let parsedCount = 0;
    let uploadedCount = 0;
    let buffer: SanctionRecord[] = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const chunk = buffer;
      buffer = [];
      const added = await session.addChunk(chunk);
      uploadedCount += added;
      process.stdout.write(`\r⏳ Importerat: ${uploadedCount} / ${parsedCount} poster...`);
    };

    const startTime = Date.now();

    if (item.parser === 'un') {
      const records = await parseUNList(item.path);
      parsedCount = records.length;
      uploadedCount = await session.addChunk(records);
    } else if (item.parser === 'uk') {
      await parseUKListStreaming(item.path, async (record) => {
        parsedCount++;
        buffer.push(record);
        if (buffer.length >= 250) await flush();
      });
      await flush();
    } else if (item.parser === 'eu') {
      await parseEUListStreaming(item.path, async (record) => {
        parsedCount++;
        buffer.push(record);
        if (buffer.length >= 250) await flush();
      });
      await flush();
    } else if (item.parser === 'us') {
      await parseUSListStreaming(item.path, async (record) => {
        parsedCount++;
        buffer.push(record);
        if (buffer.length >= 250) await flush();
      });
      await flush();
    } else if (item.parser === 'ch') {
      await parseChXmlStream(item.path, async (record) => {
        parsedCount++;
        buffer.push(record);
        if (buffer.length >= 250) await flush();
      });
      await flush();
    }

    const diff = await session.finish();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ ${item.source} klar på ${duration}s!`);
    console.log(`   Totalt tolkade: ${parsedCount}`);
    console.log(`   Nya/uppdaterade i DB: ${diff.counts.added + diff.counts.updated}`);
  }

  console.log('\n🔄 Invaliderar sökindex så alla nya poster blir sökbara...');
  await invalidateSearchIndex();
  console.log('🎉 Alla listor är färdigimporterade till Firestore!');
}

importAll().catch((err) => {
  console.error('❌ Fel under import:', err);
  process.exit(1);
});
