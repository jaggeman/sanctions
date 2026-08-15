import { Command } from 'commander';
import { db } from '../shared/firebase';
import { runImport } from '../importer';
import { runSearch } from '../search';

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

      const { results, totalMatches, truncated } = await runSearch(queryStr, {
        source: options.sources,
        type: options.type ? options.type.toLowerCase() : undefined,
        limit: parseInt(options.limit) || 10,
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
        console.log(`👤 Namn:    \x1b[1m\x1b[32m${r.primaryName}\x1b[0m`);
        console.log(`🎯 Träff:   ${r.score}% (matchade "${r.matchedAlias}")`);
        if (r.aliases && r.aliases.length > 0) {
          console.log(`🗣️ Alias:   ${r.aliases.join(', ')}`);
        }
        console.log(`🌍 Källa:   ${r.source} (${r.type})`);
        if (r.datesOfBirth) {
          console.log(`📅 Född:    ${r.datesOfBirth.join(', ')}`);
        }
        if (r.placesOfBirth) {
          console.log(`📍 Födelseort: ${r.placesOfBirth.join(', ')}`);
        }
        if (r.citizenships) {
          console.log(`🏳️ Medborgarskap: ${r.citizenships.join(', ')}`);
        }
        if (r.passports) {
          console.log(`📇 ID/Pass: ${r.passports.join(', ')}`);
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
        : ['EU', 'UN', 'US']) as ('EU' | 'UN' | 'US')[];

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
