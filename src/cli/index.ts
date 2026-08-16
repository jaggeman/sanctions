import * as path from 'path';
import * as fs from 'fs-extra';
import { Command } from 'commander';
import { db } from '../shared/firebase';
import { processUpload, runFetchTriggeredImport } from '../importer/uploadPipeline';
import { runSearch } from '../search';
import { primaryNameOf, aliasNamesOf, formatBirthDates, formatIdentifications, SanctionRecord } from '../shared/types';
import { recordsToCsv } from '../shared/csvSerializer';

export const program = new Command();

program
  .name('sanctions')
  .description('CLI för sökning och administration av sanktionsdatabasen')
  .version('1.0.0');

function printScoredResults(results: any[]) {
  results.forEach(r => {
    console.log(`--------------------------------------------------`);
    console.log(`🆔 ID:      ${r.id}`);
    console.log(`👤 Namn:    \x1b[1m\x1b[32m${primaryNameOf(r.names)}\x1b[0m`);
    console.log(`🎯 Träff:   ${r.score}% (matchade "${r.matchedAlias}")`);
    const aliases = aliasNamesOf(r.names);
    if (aliases.length > 0) {
      console.log(`🗣️ Alias:   ${aliases.join(', ')}`);
    }
    console.log(`🌍 Källa:   ${r.source} (${r.type})`);
    const birthDates = formatBirthDates(r.birthDates);
    if (birthDates.length > 0) {
      console.log(`📅 Född:    ${birthDates.join(', ')}`);
    }
    if (r.placesOfBirth) {
      console.log(`📍 Födelseort: ${r.placesOfBirth.join(', ')}`);
    }
    if (r.citizenships) {
      console.log(`🏳️ Medborgarskap: ${r.citizenships.join(', ')}`);
    }
    const identifications = formatIdentifications(r.identifications);
    if (identifications.length > 0) {
      console.log(`📇 ID/Pass: ${identifications.join(', ')}`);
    }
    if (r.sanctionReason) {
      console.log(`📝 Orsak:   ${r.sanctionReason.substring(0, 150)}${r.sanctionReason.length > 150 ? '...' : ''}`);
    }
  });
  console.log(`--------------------------------------------------`);
}

/**
 * CLI Command: search
 *
 * Issue #115: While the API and MCP server run as persistent daemon processes that amortize
 * the in-memory search index cache (`cachedRecords` in `src/search/index.ts`), single CLI
 * invocations run in their own short-lived OS process. To benefit from the warm in-memory
 * index during batch or script lookups without paying repeated full database scans,
 * the CLI supports multi-query searches in a single invocation (`sanctions search q1 q2 ...`
 * or `--file <path>`). The first query warms the cache, and all subsequent queries in the
 * batch execute against the warm in-memory index with 0 database reads.
 */
program
  .command('search')
  .description('Sök efter personer eller organisationer i databasen')
  .argument('[queries...]', 'Sökord, t.ex. namn, alias eller passnummer (ett eller flera sökord)')
  .option('-s, --sources <sources>', 'Filtrera på källor (kommatecken-separerad, t.ex. EU,UN,US)')
  .option('-t, --type <type>', 'Filtrera på typ (individual, entity, vessel, aircraft)')
  .option('-l, --limit <limit>', 'Max antal träffar att visa per sökning', '10')
  .option('--file <path>', 'Läs sökord från en textfil (ett per rad)')
  .action(async (queryArgs: string[], options) => {
    try {
      let searchQueries: string[] = [...(queryArgs || [])];

      if (options.file) {
        const filePath = path.resolve(process.cwd(), options.file);
        if (!fs.existsSync(filePath)) {
          console.error(`❌ Filen hittades inte: ${filePath}`);
          process.exit(1);
          return;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const fileQueries = content
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
        searchQueries = [...searchQueries, ...fileQueries];
      }

      if (searchQueries.length === 0) {
        console.error('❌ Ange minst ett sökord eller använd --file <sökväg>.');
        process.exit(1);
        return;
      }

      // issue #37 & issue #161: `|| 10` treats an explicit --limit 0 the same as "not
      // provided". Check for NaN and negative values explicitly — negative or NaN falls back to default 10,
      // while preserving explicit limit=0.
      const parsedLimit = parseInt(options.limit, 10);
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 0 ? 10 : parsedLimit;

      const searchOptions = {
        source: options.sources,
        type: options.type ? options.type.toLowerCase() : undefined,
        limit,
      };

      const isBatch = searchQueries.length > 1;
      if (isBatch) {
        console.log(`🚀 Startar batch-sökning för ${searchQueries.length} sökord i samma process (återanvänder uppvärmt sökindex)...\n`);
      }

      for (let i = 0; i < searchQueries.length; i++) {
        const queryStr = searchQueries[i];
        if (isBatch) {
          console.log(`==================================================`);
          console.log(`🔎 [${i + 1}/${searchQueries.length}] Söker efter "${queryStr}"...`);
          console.log(`==================================================`);
        } else {
          console.log(`Söker efter "${queryStr}"...`);
        }

        const { results, totalMatches, truncated } = await runSearch(queryStr, searchOptions);

        if (results.length === 0) {
          console.log('ℹ️ Inga träffar hittades.');
        } else {
          console.log(`\nHittade ${totalMatches} träffar (visar första ${results.length}):\n`);
          printScoredResults(results);
          if (truncated) {
            console.log(`ℹ️ Visar ${results.length} av ${totalMatches} totala träffar. Höj --limit eller skärp sökningen för fler.`);
          }
        }
        console.log();
      }

      process.exit(0);
      return;
    } catch (error: any) {
      console.error('❌ Ett fel uppstod vid sökning:', error.message);
      process.exit(1);
    }
  });

/**
 * CLI Command: details
 */
program
  .command('details')
  .description('Visa fullständiga detaljer för en specifik sanktionspost')
  .argument('<id>', 'Postens unika ID (t.ex. EU-1234 eller US-SDN-567)')
  .action(async (id) => {
    try {
      console.log(`Hämtar post ${id}...`);
      const doc = await db.collection('sanctions').doc(id).get();

      if (!doc.exists) {
        console.error(`❌ Posten med ID ${id} kunde inte hittas.`);
        process.exit(1);
        return; // process.exit never returns; this guards a stubbed exit in tests
      }

      console.log('\n📄 FULLSTÄNDIGA DETALJER:');
      console.log(JSON.stringify(doc.data(), null, 2));
      console.log();
      process.exit(0);
    } catch (error: any) {
      console.error('❌ Ett fel uppstod vid hämtning:', error.message);
      process.exit(1);
    }
  });

/**
 * CLI Command: import
 */
program
  .command('import')
  .description('Trigga en import av sanktionslistor')
  .option('-s, --sources <sources>', 'Kommateckenseparerad lista på källor att importera (EU, UN, US)')
  .option('--csv <path>', 'Sökväg till en lokal CSV-fil för PEP/CUSTOM import')
  .option('--csv-source <source>', 'Källtyp för CSV (PEP, CUSTOM)', 'PEP')
  .option('--csv-separator <separator>', 'Fältseparator i CSV-filen', ';')
  .action(async (options) => {
    try {
      console.log('🔄 Initierar import...');
      const sources = (options.sources
        ? options.sources.split(',').map((s: string) => s.trim().toUpperCase())
        : ['EU', 'UN', 'US', 'UK']) as ('EU' | 'UN' | 'US' | 'UK')[];

      // issue #192: --csv is a genuine local file, so it goes through
      // processUpload() — sha256 dedup, the in-flight lock, and a durable
      // `imports` audit record. The official-sources download below has no
      // local file to dedup on, so it goes through runFetchTriggeredImport()
      // instead (issue #256) — same durable audit record, keyed by a fresh
      // importId rather than a file hash. A bare --csv (no --sources) means
      // "just import this file": skip the official-sources download
      // entirely rather than silently triggering it too.
      let sourcesFailed = false;
      if (options.sources || !options.csv) {
        const result = await runFetchTriggeredImport({ sources, uploadedBy: 'cli' });
        if (result.success) {
          console.log('\n✅ Importen slutfördes utan fel!');
          console.log('Statistik över importerade rader:');
          console.table(result.importedCounts);
        } else {
          console.error(`❌ Importen misslyckades: ${result.error}`);
          sourcesFailed = true;
        }
      }

      let csvFailed = false;
      if (options.csv) {
        const csvResult = await processUpload({
          filePath: options.csv,
          originalFilename: path.basename(options.csv),
          sourceHint: options.csvSource,
          uploadedBy: 'cli',
          importOptions: { csvSeparator: options.csvSeparator },
        });

        if (csvResult.outcome === 'applied') {
          console.log(`\n✅ CSV-import applicerad: #${csvResult.importId}`);
        } else if (csvResult.outcome === 'rejected') {
          console.log(`\n⚪ CSV-import hoppades över: dubblett av #${csvResult.duplicateOfImportId}`);
        } else if (csvResult.outcome === 'in_flight') {
          console.log(`\n⏳ CSV-import pågår redan som #${csvResult.importId}`);
        } else if (csvResult.outcome === 'unsupported_format') {
          console.error(`❌ CSV-import: format stöds ej: ${csvResult.format}`);
          csvFailed = true;
        } else if (csvResult.outcome === 'failed') {
          console.error(`❌ CSV-import misslyckades: ${csvResult.error}`);
          csvFailed = true;
        }
      }

      process.exit(sourcesFailed || csvFailed ? 1 : 0);
    } catch (error: any) {
      console.error('❌ Ett oväntat fel uppstod under importen:', error.message);
      process.exit(1);
    }
  });

/**
 * CLI Command: import-dir
 */
program
  .command('import-dir')
  .description('Importera eller synka alla sanktionsfiler från en lokal mapp')
  .argument('<directory>', 'Sökväg till mappen som innehåller .xml / .csv-filer')
  .option('-m, --mode <mode>', 'Importläge: append eller sync', 'append')
  .option('-f, --force', 'Tvinga import även om >20% skyddet löser ut', false)
  .action(async (dirPath, options) => {
    try {
      const resolvedDir = path.resolve(process.cwd(), dirPath);
      if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
        console.error(`❌ Mappen hittades inte: ${resolvedDir}`);
        process.exit(1);
        return;
      }

      const files = fs.readdirSync(resolvedDir)
        .filter(f => f.endsWith('.xml') || f.endsWith('.csv'))
        .map(f => path.join(resolvedDir, f));

      if (files.length === 0) {
        console.log(`ℹ️ Inga .xml eller .csv-filer hittades i ${resolvedDir}`);
        process.exit(0);
        return;
      }

      console.log(`📁 Hittade ${files.length} filer i ${resolvedDir}. Startar smart import...\n`);

      const results: { file: string; outcome: string; details: string }[] = [];

      for (const filePath of files) {
        const filename = path.basename(filePath);
        console.log(`🔄 Bearbetar ${filename}...`);

        const result = await processUpload({
          filePath,
          originalFilename: filename,
          sourceHint: 'CUSTOM',
          uploadedBy: 'cli',
          importOptions: {
            mode: options.mode as 'append' | 'sync',
            force: options.force,
            dryRun: false,
          },
        });

        if (result.outcome === 'applied') {
          console.log(`  ✅ Applicerad: ${result.importId}`);
          results.push({ file: filename, outcome: 'Applied', details: `Import #${result.importId}` });
        } else if (result.outcome === 'rejected') {
          console.log(`  ⚪ Hoppade över: Dubblett av #${result.duplicateOfImportId}`);
          results.push({ file: filename, outcome: 'Skipped (Duplicate)', details: `Matches #${result.duplicateOfImportId}` });
        } else if (result.outcome === 'in_flight') {
          console.log(`  ⏳ Pågår redan som #${result.importId}`);
          results.push({ file: filename, outcome: 'In Flight', details: `Import #${result.importId}` });
        } else if (result.outcome === 'unsupported_format') {
          console.error(`  ❌ Format stöds ej: ${result.format}`);
          results.push({ file: filename, outcome: 'Unsupported Format', details: result.format });
        } else if (result.outcome === 'failed') {
          console.error(`  ❌ Misslyckades: ${result.error}`);
          results.push({ file: filename, outcome: 'Failed', details: result.error });
        }
      }

      console.log('\n==================================================');
      console.log('📊 SAMMANSTÄLLNING AV MAPP-IMPORT');
      console.log('==================================================');
      console.table(results);
      process.exit(0);
    } catch (error: any) {
      console.error('❌ Ett fel uppstod under importen:', error.message);
      process.exit(1);
    }
  });

/**
 * CLI Command: stats
 */
program
  .command('stats')
  .description('Visa statistik över sparade sanktionsposter i databasen')
  .action(async () => {
    try {
      console.log('📊 Hämtar statistik från databasen...');

      const totalCount = (await db.collection('sanctions').count().get()).data().count;
      const euCount = (await db.collection('sanctions').where('source', '==', 'EU').count().get()).data().count;
      const unCount = (await db.collection('sanctions').where('source', '==', 'UN').count().get()).data().count;
      const usCount = (await db.collection('sanctions').where('source', '==', 'US').count().get()).data().count;
      const pepCount = (await db.collection('sanctions').where('source', '==', 'PEP').count().get()).data().count;

      console.log(`\n==================================================`);
      console.log(`📊 DATABASSTATISTIK`);
      console.log(`==================================================`);
      console.log(`📝 Totalt antal poster:  \x1b[1m${totalCount}\x1b[0m`);
      console.log(`--------------------------------------------------`);
      console.log(`🇪🇺 EU-sanktioner:       ${euCount}`);
      console.log(`🇺🇳 FN-sanktioner:       ${unCount}`);
      console.log(`🇺🇸 US (OFAC SDN):       ${usCount}`);
      console.log(`👤 PEP (Sverige/osv):   ${pepCount}`);
      console.log(`==================================================\n`);
      process.exit(0);
    } catch (error: any) {
      console.error('❌ Kunde inte hämta statistik:', error.message);
      process.exit(1);
    }
  });

/**
 * CLI Command: export
 */
program
  .command('export')
  .description('Exportera sanktionsdata som CSV-fil')
  .option('-s, --sources <sources>', 'Filtrera på källor (kommatecken-separerad, t.ex. EU,UN,US)')
  .option('-t, --type <type>', 'Filtrera på typ (individual, entity, vessel, aircraft)')
  .option('--status <status>', 'Filtrera på status (active, delisted, all)', 'active')
  .option('--import-id <importId>', 'Filtrera på specifik importId')
  .option('-o, --output <path>', 'Sökväg till output CSV-fil (om ej angiven skrivs till stdout)')
  .action(async (options) => {
    try {
      const sourcesFilter = options.sources
        ? options.sources.split(',').map((s: string) => s.trim().toUpperCase())
        : null;
      const typeFilter = options.type ? options.type.trim().toLowerCase() : null;
      const statusFilter = options.status ? options.status.trim().toLowerCase() : 'active';
      const importIdFilter = options.importId ? options.importId.trim() : null;

      const snapshot = await db.collection('sanctions').get();
      const records: SanctionRecord[] = [];

      snapshot.docs.forEach((doc: any) => {
        const r = doc.data() as SanctionRecord;
        const recordStatus = r.status || 'active';
        if (statusFilter !== 'all' && recordStatus !== statusFilter) return;
        if (sourcesFilter && !sourcesFilter.includes(r.source.toUpperCase())) return;
        if (typeFilter && r.type.toLowerCase() !== typeFilter) return;
        if (importIdFilter && r.firstSeenImport !== importIdFilter && r.lastSeenImport !== importIdFilter) return;
        records.push(r);
      });

      const csv = recordsToCsv(records);

      if (options.output) {
        const outPath = path.resolve(process.cwd(), options.output);
        await fs.outputFile(outPath, csv, 'utf-8');
        console.log(`✅ Exporterade ${records.length} poster till: ${outPath}`);
      } else {
        process.stdout.write(csv + '\n');
      }
      process.exit(0);
    } catch (error: any) {
      console.error('❌ Kunde inte exportera data:', error.message);
      process.exit(1);
    }
  });

// Guarded so importing this module (e.g. from tests) doesn't also parse the
// importer's own process.argv.
if (require.main === module) {
  program.parse(process.argv);
}
