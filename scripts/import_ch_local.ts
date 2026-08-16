import * as path from 'path';
import * as fs from 'fs-extra';
import { parseChXmlStream } from '../src/importer/parsers/ch';
import { startDiffSession } from '../src/importer/diff';
import { invalidateSearchIndex } from '../src/search';
import { SanctionRecord } from '../src/shared/types';

async function importCh() {
  const filePath = path.resolve(__dirname, '../downloads/ch_sanctions.xml');
  console.log('🚀 Startar import av Schweiz (SECO) sanktionslista till Firestore...');
  console.log(`📦 Fil: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Filen hittades inte: ${filePath}`);
    process.exit(1);
  }

  const session = await startDiffSession('CH', { mode: 'append' });
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

  await parseChXmlStream(filePath, async (record) => {
    parsedCount++;
    buffer.push(record);
    if (buffer.length >= 250) await flush();
  });
  await flush();

  const diff = await session.finish();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\n✅ Schweiz (CH) klar på ${duration}s!`);
  console.log(`   Totalt tolkade poster: ${parsedCount}`);
  console.log(`   Nya/uppdaterade i Firestore: ${diff.counts.added + diff.counts.updated}`);
  console.log(`   Oförändrade: ${diff.counts.unchanged}`);

  console.log('\n🔄 Invaliderar sökindex...');
  await invalidateSearchIndex();
  console.log('🎉 Schweiz sanktionslista är nu fullt sökbar i databasen!');
}

importCh().catch((err) => {
  console.error('❌ Fel under import av CH:', err);
  process.exit(1);
});
