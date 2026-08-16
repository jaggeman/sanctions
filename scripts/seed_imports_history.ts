import { db } from '../src/shared/firebase';
import { ImportRecord } from '../src/shared/types';

async function seedImports() {
  const initialImports: ImportRecord[] = [
    {
      importId: 'initial-un-xml',
      trigger: 'upload',
      filename: 'un_sanctions.xml',
      sha256: 'un-official-consolidated-20260814',
      sizeBytes: 1540000,
      source: 'UN',
      format: 'un-xml',
      fileGenerationDate: '2026-08-14T23:00:04.744Z',
      uploadedBy: 'admin@sanctions.com',
      uploadedAt: new Date(Date.now() - 3600 * 1000 * 3).toISOString(),
      status: 'applied',
      counts: { parsed: 1011, uploaded: 1011 },
    },
    {
      importId: 'initial-uk-xml',
      trigger: 'upload',
      filename: 'uk_sanctions.xml',
      sha256: 'uk-official-sanctions-20260814',
      sizeBytes: 16747000,
      source: 'UK',
      format: 'uk-xml',
      fileGenerationDate: '14/08/2026',
      uploadedBy: 'admin@sanctions.com',
      uploadedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
      status: 'applied',
      counts: { parsed: 6334, uploaded: 6334 },
    },
    {
      importId: 'initial-eu-xml',
      trigger: 'upload',
      filename: '20260805-FULL-1_1(xsd).xml',
      sha256: 'eu-official-fsd-20260805',
      sizeBytes: 25480000,
      source: 'EU',
      format: 'eu-xml-1.1',
      fileGenerationDate: '2026-08-05T16:47:04.449+02:00',
      uploadedBy: 'admin@sanctions.com',
      uploadedAt: new Date(Date.now() - 3600 * 1000 * 1).toISOString(),
      status: 'applied',
      counts: { parsed: 6234, uploaded: 6234 },
    },
    {
      importId: 'initial-us-xml',
      trigger: 'upload',
      filename: 'us_sdn.xml',
      sha256: 'us-official-sdn-20260807',
      sizeBytes: 29800000,
      source: 'US',
      format: 'us-xml',
      fileGenerationDate: '08/07/2026',
      uploadedBy: 'admin@sanctions.com',
      uploadedAt: new Date(Date.now() - 1800 * 1000).toISOString(),
      status: 'applied',
      counts: { parsed: 19199, uploaded: 19199 },
    },
    {
      importId: 'initial-ch-xml',
      trigger: 'upload',
      filename: 'ch_sanctions.xml',
      sha256: 'ch-seco-sesam-20260816',
      sizeBytes: 40121793,
      source: 'CH',
      format: 'ch-xml',
      fileGenerationDate: '2026-08-16T11:40:00.000Z',
      uploadedBy: 'admin@sanctions.com',
      uploadedAt: new Date().toISOString(),
      status: 'applied',
      counts: { parsed: 8664, uploaded: 8664 },
    },
  ];

  for (const imp of initialImports) {
    await db.collection('imports').doc(imp.importId).set(imp, { merge: true });
    console.log(`✅ Synced import history for ${imp.source}: ${imp.filename}`);
  }
}

seedImports().then(() => {
  console.log('🎉 Import history seeded successfully!');
  process.exit(0);
}).catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
