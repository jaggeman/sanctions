import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { parseEUList, parseEUListStreaming } from '../../src/importer/parsers/eu';

const FIXTURE = path.join(__dirname, '../fixtures/eu_sample.xml');

describe('parseEUListStreaming', () => {
  it('emits one record per sanctionEntity via callback', async () => {
    const seen: string[] = [];
    const count = await parseEUListStreaming(FIXTURE, (record) => {
      seen.push(record.id);
    });
    expect(count).toBe(5);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5); // no duplicates, none skipped
  });

  it('produces records matching parseEUList\'s array output field-for-field', async () => {
    const viaArray = await parseEUList(FIXTURE);
    const viaCallback: typeof viaArray = [];
    await parseEUListStreaming(FIXTURE, (record) => {
      viaCallback.push(record);
    });

    // createdAt/updatedAt are real timestamps stamped at map time, so they
    // legitimately differ between two independent parse runs.
    const stripTimestamps = (a: typeof viaArray) =>
      [...a]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map(({ createdAt, updatedAt, ...rest }) => rest);
    expect(stripTimestamps(viaCallback)).toEqual(stripTimestamps(viaArray));
  });

  it('does not retain the full parsed source node on the emitted record', async () => {
    await parseEUListStreaming(FIXTURE, (record) => {
      expect(record.rawSourceData).toBeUndefined();
    });
  });

  it('supports an async onRecord callback (backpressure-safe) without dropping records', async () => {
    const seen: string[] = [];
    await parseEUListStreaming(FIXTURE, async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(record.id);
    });
    expect(seen.length).toBe(5);
  });

  it('validates logicalId the same way the array API does', async () => {
    const tmp = path.join(os.tmpdir(), `eu-unsafe-streaming-${process.pid}.xml`);
    await fs.writeFile(
      tmp,
      `<?xml version="1.0"?><export xmlns="http://eu.europa.ec/fpi/fsd/export">
         <sanctionEntity logicalId="../../admin/evil">
           <subjectType code="person" classificationCode="P"/>
           <nameAlias wholeName="Path Traversal" strong="true"/>
         </sanctionEntity>
         <sanctionEntity logicalId="42">
           <subjectType code="person" classificationCode="P"/>
           <nameAlias wholeName="Legitimate Record" strong="true"/>
         </sanctionEntity>
       </export>`,
      'utf-8',
    );
    try {
      const seen: string[] = [];
      await parseEUListStreaming(tmp, (record) => {
        seen.push(record.id);
      });
      expect(seen).toEqual(['EU-42']);
    } finally {
      await fs.remove(tmp);
    }
  });

  it('resolves to 0 and never calls back when there are no sanctionEntity nodes', async () => {
    const tmp = path.join(os.tmpdir(), `eu-empty-streaming-${process.pid}.xml`);
    await fs.writeFile(
      tmp,
      '<?xml version="1.0"?><export xmlns="http://eu.europa.ec/fpi/fsd/export"></export>',
      'utf-8',
    );
    try {
      let calls = 0;
      const count = await parseEUListStreaming(tmp, () => {
        calls++;
      });
      expect(count).toBe(0);
      expect(calls).toBe(0);
    } finally {
      await fs.remove(tmp);
    }
  });
});
