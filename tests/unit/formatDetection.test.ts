import { describe, it, expect } from 'vitest';
import { open } from 'fs/promises';
import * as path from 'path';
import { detectFormat } from '../../src/importer/formatDetection';

// Absolute path: the real sample files live in the main checkout's untracked
// lists/ directory, not inside this feature worktree.
const LISTS_DIR = 'C:/Sanctions/lists';

/** Reads just the first `bytes` of a real file — detection must work off a
 * small prefix, not the whole file (issue #5's streaming ethos: never read a
 * 25 MB file fully just to sniff its type). */
async function head(file: string, bytes = 4096): Promise<string> {
  const buf = Buffer.alloc(bytes);
  const fh = await open(path.join(LISTS_DIR, file), 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close();
  }
}

describe('detectFormat — real files in lists/ (issue #7 acceptance criterion)', () => {
  it('detects the EU XML export and extracts generationDate from the root attribute', async () => {
    const content = await head('20260805-FULL-1_1(xsd).xml');
    const result = detectFormat(content);
    expect(result.format).toBe('eu-xml-1.1');
    expect(result.fileGenerationDate).toBe('2026-08-05T16:47:04.449+02:00');
  });

  it('detects the EU CSV v1.0 export and extracts fileGenerationDate from the first data row', async () => {
    const content = await head('20260805-FULL-1_0.csv');
    const result = detectFormat(content);
    expect(result.format).toBe('eu-csv-1.0');
    expect(result.fileGenerationDate).toBe('05/08/2026');
  });

  it('detects the EU CSV v1.1 export and extracts fileGenerationDate from the first data row', async () => {
    const content = await head('20260805-FULL-1_1.csv');
    const result = detectFormat(content);
    expect(result.format).toBe('eu-csv-1.1');
    expect(result.fileGenerationDate).toBe('05/08/2026');
  });

  it('falls back to generic csv for a file with an unrecognised header shape', async () => {
    const content = await head('eu_sanktionslista_screening_2026-08-15.csv');
    const result = detectFormat(content);
    expect(result.format).toBe('csv');
    expect(result.fileGenerationDate).toBeNull();
  });
});

describe('detectFormat — UN and US XML (existing downloaded sources)', () => {
  it('detects the UN consolidated list XML and extracts dateGenerated', () => {
    const content = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<CONSOLIDATED_LIST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" dateGenerated="2026-08-14T23:00:04.744Z">\n  <INDIVIDUALS>`;
    const result = detectFormat(content);
    expect(result.format).toBe('un-xml');
    expect(result.fileGenerationDate).toBe('2026-08-14T23:00:04.744Z');
  });

  it('detects the US OFAC SDN XML', () => {
    const content = `<?xml version="1.0" standalone="yes"?>\n<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">\n  <publshInformation>\n    <Publish_Date>08/07/2026</Publish_Date>`;
    const result = detectFormat(content);
    expect(result.format).toBe('us-xml');
    expect(result.fileGenerationDate).toBe('08/07/2026');
  });

  it('detects the UK Sanctions List XML and extracts DateGenerated', async () => {
    const content = await head('uk_sanctions.xml');
    const result = detectFormat(content);
    expect(result.format).toBe('uk-xml');
    expect(result.fileGenerationDate).toBe('14/08/2026');
  });
});

describe('detectFormat — generic / edge cases', () => {
  it('detects a simple semicolon PEP-style CSV as generic csv', () => {
    const content = 'id;name;aliases;type;source\n1;Test Person;;individual;PEP\n';
    const result = detectFormat(content);
    expect(result.format).toBe('csv');
  });

  it('handles a UTF-8 BOM before the header without misdetecting', () => {
    const content = '﻿Date_file;Entity_logical_id;Subject_type\n05/08/2026;13;P\n';
    const result = detectFormat(content);
    expect(result.format).toBe('eu-csv-1.0');
    expect(result.fileGenerationDate).toBe('05/08/2026');
  });

  it('returns null fileGenerationDate for a malformed/empty file rather than throwing', () => {
    expect(() => detectFormat('')).not.toThrow();
    expect(detectFormat('').fileGenerationDate).toBeNull();
    expect(detectFormat('').format).toBe('csv');
  });
});
