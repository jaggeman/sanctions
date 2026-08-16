import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { parseUSList, parseUSListStreaming } from '../../src/importer/parsers/us';

const FIXTURE = path.join(__dirname, '../fixtures/us_sample.xml');

describe('parseUSListStreaming', () => {
  it('emits one record per sdnEntry via callback', async () => {
    const seen: string[] = [];
    const count = await parseUSListStreaming(FIXTURE, (record) => {
      seen.push(record.id);
    });
    expect(count).toBe(5);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("produces records matching parseUSList's array output field-for-field", async () => {
    const viaArray = await parseUSList(FIXTURE);
    const viaCallback: typeof viaArray = [];
    await parseUSListStreaming(FIXTURE, (record) => {
      viaCallback.push(record);
    });

    const stripTimestamps = (a: typeof viaArray) =>
      [...a]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map(({ createdAt, updatedAt, ...rest }) => rest);
    expect(stripTimestamps(viaCallback)).toEqual(stripTimestamps(viaArray));
  });

  it('supports an async onRecord callback (backpressure-safe) without dropping records', async () => {
    const seen: string[] = [];
    await parseUSListStreaming(FIXTURE, async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(record.id);
    });
    expect(seen.length).toBe(5);
  });

  it('returns 0 and emits nothing when sdnEntry is absent', async () => {
    const tmp = path.join(os.tmpdir(), `us-empty-streaming-${process.pid}.xml`);
    await fs.writeFile(tmp, '<?xml version="1.0"?><sdnList></sdnList>', 'utf-8');
    try {
      const seen: string[] = [];
      const count = await parseUSListStreaming(tmp, (record) => seen.push(record.id));
      expect(count).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      await fs.remove(tmp);
    }
  });

  it('streams a single sdnEntry the same as the array API', async () => {
    const tmp = path.join(os.tmpdir(), `us-single-streaming-${process.pid}.xml`);
    const xml = `<?xml version="1.0"?><sdnList><sdnEntry><uid>1</uid><lastName>Solo</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>`;
    await fs.writeFile(tmp, xml, 'utf-8');
    try {
      const seen: any[] = [];
      const count = await parseUSListStreaming(tmp, (record) => seen.push(record));
      expect(count).toBe(1);
      expect(seen[0].primaryName).toBe('Solo');
    } finally {
      await fs.remove(tmp);
    }
  });
});
