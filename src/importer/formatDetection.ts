export type DetectedFormat = 'eu-xml-1.1' | 'eu-csv-1.1' | 'eu-csv-1.0' | 'un-xml' | 'us-xml' | 'uk-xml' | 'ch-xml' | 'csv';

export interface FormatDetectionResult {
  format: DetectedFormat;
  fileGenerationDate: string | null;
}

const BOM = '﻿';

function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

function extractXmlAttribute(content: string, tagStart: string, attr: string): string | null {
  const tagIdx = content.indexOf(tagStart);
  if (tagIdx === -1) return null;
  // Only look inside the opening tag itself, not the whole document.
  const tagEnd = content.indexOf('>', tagIdx);
  const tag = content.slice(tagIdx, tagEnd === -1 ? undefined : tagEnd);
  const match = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return match ? match[1] : null;
}

/**
 * Sniffs which of the pipeline's known source formats a file is, from a
 * small content prefix — never needs the whole file (issue #5's streaming
 * ethos applies to detection too). Also extracts fileGenerationDate, which is
 * a property of the file's own content, not the upload timestamp (issue #7's
 * own gotcha: getting this backwards makes import history lie about which
 * snapshot is newer).
 */
export function detectFormat(rawContent: string): FormatDetectionResult {
  const content = stripBom(rawContent).trimStart();

  if (content.startsWith('<?xml')) {
    if (content.includes('<export ') || content.includes('xmlns="http://eu.europa.ec/fpi/fsd/export"')) {
      return { format: 'eu-xml-1.1', fileGenerationDate: extractXmlAttribute(content, '<export', 'generationDate') };
    }
    if (content.includes('<CONSOLIDATED_LIST')) {
      return { format: 'un-xml', fileGenerationDate: extractXmlAttribute(content, '<CONSOLIDATED_LIST', 'dateGenerated') };
    }
    if (content.includes('<sdnList')) {
      const match = content.match(/<Publish_Date>([^<]*)<\/Publish_Date>/);
      return { format: 'us-xml', fileGenerationDate: match ? match[1] : null };
    }
    if (content.includes('<Designations')) {
      const match = content.match(/<DateGenerated>([^<]*)<\/DateGenerated>/);
      return { format: 'uk-xml', fileGenerationDate: match ? match[1] : null };
    }
    if (content.includes('<swiss-sanctions-list')) {
      return { format: 'ch-xml', fileGenerationDate: extractXmlAttribute(content, '<swiss-sanctions-list', 'date') };
    }
    return { format: 'csv', fileGenerationDate: null }; // unrecognised XML — fall through safely
  }

  const lines = content.split(/\r?\n/);
  const header = (lines[0] || '').toLowerCase();
  const firstDataRow = lines[1] || '';
  const firstColumn = firstDataRow.split(';')[0]?.trim() || null;

  if (header.startsWith('date_file;')) {
    return { format: 'eu-csv-1.0', fileGenerationDate: firstColumn || null };
  }
  if (header.startsWith('filegenerationdate;')) {
    return { format: 'eu-csv-1.1', fileGenerationDate: firstColumn || null };
  }

  return { format: 'csv', fileGenerationDate: null };
}
