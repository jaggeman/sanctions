import * as path from 'path';
import * as fs from 'fs-extra';
import { Command } from 'commander';
import { db } from '../shared/firebase';
import { runImport } from '../importer';
import { processUpload } from '../importer/uploadPipeline';
import { runSearch } from '../search';
import { primaryNameOf, aliasNamesOf, formatBirthDates, formatIdentifications } from '../shared/types';

export const program = new Command();

program
  .name('sanctions')
  .description('CLI för sökning och administration av sanktionsdatabasen')
  .version('1.0.0');

/**
 * CLI Command: search
 */
program
  .command('search')
  .description('Sök efter personer eller organisationer i databasen')
  .argument('<query>', 'Sökord, t.ex. namn, alias eller passnummer')
  .option('-s, --sources <sources>', 'Filtrera på källor (kommatecken-separerad, t.ex. EU,UN,US)')
  .option('-t, --type <type>', 'Filtrera på typ (individual, entity, vessel, aircraft)')
  .option('-l, --limit <limit>', 'Max antal träffar att visa', '10')
  .action(async (queryStr, options) => {
    try {
      console.log(`Söker efter "${queryStr}"...`);

      // issue #37 & issue #161: `|| 10` treats an explicit --limit 0 the same as "not
      // provided". Check for NaN and negative values explicitly — negative or NaN falls back to default 10,
      // while preserving explicit limit=0.
      const parsedLimit = parseInt(options.limit, 10);
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 0 ? 10 : parsedLimit;

      const { results, totalMatches, truncated } = await runSearch(queryStr, {
        source: options.sources,
        type: options.type ? options.type.toLowerCase() : undefined,
        limit,
      });

      if (results.length === 0) {
        console.log('ℹ️ Inga träffar hittades.');
        process.exit(0);
        return; // process.exit never returns; this guards a stubbed exit in tests
      }

      console.log(`\nHittade ${totalMatches} träffar (visar första ${results.length}):\n`);

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
      if (truncated) {
        console.log(`ℹ️ Visar ${results.length} av ${totalMatches} totala träffar. Höj --limit eller skärp sökningen för fler.`);
      }
      console.log();
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

      const result = await runImport({
        sources,
        csvPath: options.csv,
        csvSource: options.csvSource,
        csvSeparator: options.csvSeparator,
      });

      if (result.success) {
        console.log('\n✅ Importen slutfördes utan fel!');
        console.log('Statistik över importerade rader:');
        console.table(result.importedCounts);
        process.exit(0);
      } else {
        console.error(`❌ Importen misslyckades: ${result.error}`);
        process.exit(1);
      }

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

// Guarded so importing this module (e.g. from tests) doesn't also parse the
// importer's own process.argv.
if (require.main === module) {
  program.parse(process.argv);
}
