import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import { db } from '../shared/firebase';
import { processUpload, runFetchTriggeredImport } from '../importer/uploadPipeline';
import { runSearch } from '../search';
import { getOverride } from '../overrides';
import { listDecisionsForEntity } from '../decisions';
import { primaryNameOf, aliasNamesOf, formatBirthDates } from '../shared/types';

// Create the MCP server instance
const server = new Server(
  {
    name: 'sanctions-search-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

/**
 * List available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_sanctions',
        description: 'Sök efter personer eller organisationer på EU:s, FN:s, USA:s (OFAC) och PEP-sanktionslistor.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Sökord, t.ex. namn, alias eller passnummer.',
            },
            source: {
              type: 'string',
              description: 'Filtrera på källa (t.ex. EU, UN, US, PEP). Separera med kommatecken.',
            },
            type: {
              type: 'string',
              enum: ['individual', 'entity', 'vessel', 'aircraft'],
              description: 'Filtrera på typ (t.ex. individual för personer, entity för organisationer).',
            },
            limit: {
              type: 'number',
              description: 'Max antal resultat att returnera (standard 10).',
              default: 10,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_sanction_details',
        description: 'Hämta fullständiga detaljer för en specifik sanktionspost baserat på dess unika ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Det unika ID:t för posten, t.ex. "EU-1234" eller "US-SDN-999".',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'run_database_import',
        description: 'Ladda ner och importera de senaste sanktionslistorna till databasen.',
        inputSchema: {
          type: 'object',
          properties: {
            sources: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['EU', 'UN', 'US'],
              },
              description: 'Källor som ska uppdateras (EU, UN, US). Om utelämnad uppdateras alla.',
            },
            csvPath: {
              type: 'string',
              description: 'Frivillig sökväg till en lokal CSV-fil med PEP- eller anpassad data att importera.',
            },
          },
        },
      },
      {
        name: 'get_override',
        description: 'Hämta den manuella korrigeringen (override) som är sparad för en specifik sanktionspost, om någon finns.',
        inputSchema: {
          type: 'object',
          properties: {
            entityId: {
              type: 'string',
              description: 'Det unika ID:t för sanktionsposten, t.ex. "EU-1234".',
            },
          },
          required: ['entityId'],
        },
      },
      {
        name: 'create_override',
        description: 'Skapa eller ersätt en manuell korrigering (override) för en sanktionspost. Anropar det riktiga skriv-API:et med en skriv-skopad API-token (MCP_API_TOKEN) — ändringen attribueras alltid till tokenens ägare, aldrig till den anropande agenten.',
        inputSchema: {
          type: 'object',
          properties: {
            entityId: {
              type: 'string',
              description: 'Det unika ID:t för sanktionsposten att korrigera.',
            },
            fields: {
              type: 'object',
              description: 'Fält att overrida, t.ex. {"sanctionReason": "Uppdaterad text"}. Kan INTE innehålla: id, source, type, createdAt, searchNames, status.',
            },
            reason: {
              type: 'string',
              description: 'Motivering till korrigeringen (obligatorisk, sparas i granskningsloggen).',
            },
          },
          required: ['entityId', 'fields', 'reason'],
        },
      },
      {
        name: 'record_decision',
        description: 'Registrera eller skriv över en analytisk bedömning (falskt eller sant positivt fynd) för en sanktionspost och ett kund/subjekt-ID. Kräver en skriv-skopad API-token (MCP_API_TOKEN); bedömningen attribueras till tokenens ägare.',
        inputSchema: {
          type: 'object',
          properties: {
            entityId: {
              type: 'string',
              description: 'Det unika ID:t för sanktionsposten.',
            },
            subjectId: {
              type: 'string',
              description: 'ID för kunden/subjektet bedömningen gäller.',
            },
            verdict: {
              type: 'string',
              enum: ['false_positive', 'true_positive'],
              description: 'Bedömningens utfall.',
            },
            notes: {
              type: 'string',
              description: 'Frivillig kommentar till bedömningen.',
            },
          },
          required: ['entityId', 'subjectId', 'verdict'],
        },
      },
      {
        name: 'list_decisions_for_entity',
        description: 'Lista alla registrerade bedömningar för en sanktionspost, över alla kund/subjekt-ID:n.',
        inputSchema: {
          type: 'object',
          properties: {
            entityId: {
              type: 'string',
              description: 'Det unika ID:t för sanktionsposten.',
            },
          },
          required: ['entityId'],
        },
      },
    ],
  };
});

/**
 * Handles the search_sanctions tool. Exported so it can be unit tested
 * directly, and so it shares src/search's fuzzy matcher with the REST API
 * and CLI rather than keeping its own copy of the query logic (issue #11).
 */
export async function handleSearchSanctions(args: any) {
  const queryStr = String(args?.query || '').trim();
  // issue #37: this message promises "minst 2 tecken långt" (at least 2
  // characters), but the code only rejected an empty string — a 1-character
  // query slipped through and got fuzzy-matched anyway.
  if (queryStr.length < 2) {
    return {
      content: [{ type: 'text', text: 'Sökordet måste anges och vara minst 2 tecken långt.' }],
    };
  }

  // issue #149: validate limit argument. A non-numeric (e.g. "alla") or negative
  // limit must fall back to default (undefined) instead of coercing to NaN or negative,
  // which causes slice(0, NaN) => [] resulting in false negatives.
  // Preserve explicit limit=0 per issue #37.
  let parsedLimit: number | undefined = undefined;
  if (args?.limit !== undefined && args?.limit !== null) {
    if (typeof args.limit === 'number' && !Number.isNaN(args.limit) && args.limit >= 0) {
      parsedLimit = Math.floor(args.limit);
    } else if (typeof args.limit === 'string' && args.limit.trim() !== '') {
      const n = Number(args.limit.trim());
      if (!Number.isNaN(n) && n >= 0) {
        parsedLimit = Math.floor(n);
      }
    }
  }

  const { results, totalMatches, truncated } = await runSearch(queryStr, {
    source: args?.source ? String(args.source) : undefined,
    type: args?.type ? String(args.type) : undefined,
    limit: parsedLimit,
  });

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `Inga sanktioner matchade din sökning: "${queryStr}"` }],
    };
  }

  const formatted = results.map(r => {
    const aliases = aliasNamesOf(r.names);
    const aliasStr = aliases.length > 0 ? ` (Alias: ${aliases.join(', ')})` : '';
    const birthDates = formatBirthDates(r.birthDates);
    const dobStr = birthDates.length > 0 ? ` | DOB: ${birthDates.join(', ')}` : '';
    const reasonStr = r.sanctionReason ? ` | Orsak: ${r.sanctionReason.substring(0, 100)}${r.sanctionReason.length > 100 ? '...' : ''}` : '';
    return `[${r.id}] ${primaryNameOf(r.names)}${aliasStr} - Källa: ${r.source} (${r.type}) - Träffsäkerhet: ${r.score}% (matchade "${r.matchedAlias}")${dobStr}${reasonStr}`;
  }).join('\n');

  const truncationNote = truncated
    ? `\n\n(Visar ${results.length} av ${totalMatches} totala träffar — sök med en snävare fråga eller höj limit för fler.)`
    : '';

  return {
    content: [{ type: 'text', text: `Hittade ${totalMatches} träffar (visar de första ${results.length}):\n\n${formatted}${truncationNote}` }],
  };
}

/**
 * Calls the real running REST API with a write-scoped bearer token. Used by
 * every MCP tool that writes (create_override, record_decision) instead of
 * touching Firestore/internal modules directly — this reuses the server's
 * own auth, validation (IMMUTABLE_KEYS, entity-existence, etc.) and, above
 * all, its attribution of overriddenBy/decidedBy to a real authenticated
 * identity (req.userEmail), which MCP has no session of its own to provide.
 *
 * Config is read per-call, not cached at module load, so a long-lived MCP
 * stdio process picks up a rotated token without a restart — same
 * "re-read on every call, don't cache at startup" convention as
 * ALLOWED_EMAIL_DOMAINS. Deliberately no default for MCP_API_BASE_URL: an
 * agent silently writing real, attributed records to an unintended target
 * is worse than a clear config error.
 */
export async function callSanctionsApi(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: any }> {
  const baseUrl = process.env.MCP_API_BASE_URL;
  if (!baseUrl) {
    return { ok: false, status: 0, body: { error: 'MCP_API_BASE_URL saknas — sätt Sanctions-API:ets bas-URL i miljövariabeln MCP_API_BASE_URL.' } };
  }

  const token = process.env.MCP_API_TOKEN;
  if (!token) {
    return { ok: false, status: 0, body: { error: 'MCP_API_TOKEN saknas — sätt en skriv-skopad API-token i miljövariabeln MCP_API_TOKEN.' } };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    return { ok: false, status: 0, body: { error: `Kunde inte nå Sanctions-API:et på ${baseUrl}: ${err.message}` } };
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = { error: res.statusText || 'Ogiltigt svar från API:et.' };
  }

  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Handles the get_override tool. A read — calls src/overrides directly, same
 * trust model as handleGetSanctionDetails, since a read attributes nothing
 * to anyone (unlike create_override/record_decision, which must go through
 * the real HTTP API — see callSanctionsApi's own comment).
 */
export async function handleGetOverride(args: any) {
  const entityId = String(args?.entityId || '');
  const override = await getOverride(entityId);

  if (!override) {
    return {
      content: [{ type: 'text', text: `Ingen override finns sparad för ${entityId}.` }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(override, null, 2) }],
  };
}

/**
 * Handles the create_override tool. Proxies PUT /api/overrides/:id through
 * the real HTTP API — see callSanctionsApi's own comment for why.
 */
export async function handleCreateOverride(args: any) {
  const entityId = String(args?.entityId || '');
  const result = await callSanctionsApi('PUT', `/api/overrides/${entityId}`, {
    fields: args?.fields,
    reason: args?.reason,
  });

  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.body?.error || `API-anrop misslyckades (${result.status}).` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Override sparad för ${entityId}:\n${JSON.stringify(result.body, null, 2)}` }],
  };
}

/**
 * Handles the record_decision tool. Proxies POST /api/decisions through the
 * real HTTP API — see callSanctionsApi's own comment for why.
 */
export async function handleRecordDecision(args: any) {
  const result = await callSanctionsApi('POST', '/api/decisions', {
    entityId: args?.entityId,
    subjectId: args?.subjectId,
    verdict: args?.verdict,
    ...(args?.notes !== undefined ? { notes: args.notes } : {}),
  });

  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.body?.error || `API-anrop misslyckades (${result.status}).` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Bedömning sparad:\n${JSON.stringify(result.body, null, 2)}` }],
  };
}

/**
 * Handles the list_decisions_for_entity tool. A read — calls src/decisions
 * directly, same trust model as handleGetSanctionDetails.
 */
export async function handleListDecisionsForEntity(args: any) {
  const entityId = String(args?.entityId || '');
  const decisions = await listDecisionsForEntity(entityId);

  if (decisions.length === 0) {
    return {
      content: [{ type: 'text', text: `Inga bedömningar registrerade för ${entityId}.` }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(decisions, null, 2) }],
  };
}

/**
 * Handles the get_sanction_details tool. Exported so it can be unit tested
 * directly (issue #71), mirroring the handleSearchSanctions pattern.
 */
export async function handleGetSanctionDetails(args: any) {
  const id = String(args?.id || '');
  const doc = await db.collection('sanctions').doc(id).get();

  if (!doc.exists) {
    return {
      content: [{ type: 'text', text: `Kunde inte hitta någon sanktionspost med ID: ${id}` }],
      isError: true,
    };
  }

  const data = doc.data();
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Handles the run_database_import tool. Exported so it can be unit tested
 * directly (issue #71), mirroring the handleSearchSanctions pattern.
 */
export async function handleRunDatabaseImport(args: any) {
  const sources = args?.sources as ('EU' | 'UN' | 'US')[] | undefined;
  const csvPath = args?.csvPath as string | undefined;

  // issue #192: csvPath is a genuine local file, so it goes through
  // processUpload() — sha256 dedup, the in-flight lock, and a durable
  // `imports` audit record. The official-sources download below has no
  // local file to dedup on, so it goes through runFetchTriggeredImport()
  // instead (issue #256) — same durable audit record, keyed by a fresh
  // importId rather than a file hash. A bare csvPath (no sources) means
  // "just import this file": skip the official-sources download entirely
  // rather than silently triggering it too via the old default-to-all-
  // sources fallback.
  let sourcesResult: Awaited<ReturnType<typeof runFetchTriggeredImport>> | undefined;
  if (sources || !csvPath) {
    sourcesResult = await runFetchTriggeredImport({ sources, uploadedBy: null });
  }

  let csvResult: Awaited<ReturnType<typeof processUpload>> | undefined;
  if (csvPath) {
    csvResult = await processUpload({
      filePath: csvPath,
      originalFilename: path.basename(csvPath),
      sourceHint: 'PEP',
      uploadedBy: null,
      importOptions: {},
    });
  }

  const csvFailed = csvResult?.outcome === 'failed' || csvResult?.outcome === 'unsupported_format';
  if ((sourcesResult && !sourcesResult.success) || csvFailed) {
    const parts: string[] = [];
    if (sourcesResult && !sourcesResult.success) parts.push(sourcesResult.error || 'Källimport misslyckades');
    if (csvResult?.outcome === 'failed') parts.push(csvResult.error);
    if (csvResult?.outcome === 'unsupported_format') parts.push(`CSV-format stöds ej: ${csvResult.format}`);
    return {
      content: [{ type: 'text', text: `Import misslyckades: ${parts.join('; ')}` }],
      isError: true,
    };
  }

  const lines: string[] = [];
  if (sourcesResult) {
    lines.push(
      'Import slutförd framgångsrikt!',
      'Antal poster importerade per källa:',
      JSON.stringify(sourcesResult.importedCounts, null, 2),
    );
  }
  if (csvResult) {
    if (csvResult.outcome === 'applied') {
      lines.push(`CSV-import applicerad: #${csvResult.importId}`);
    } else if (csvResult.outcome === 'rejected') {
      lines.push(`CSV-import hoppades över: dubblett av #${csvResult.duplicateOfImportId}`);
    } else if (csvResult.outcome === 'in_flight') {
      lines.push(`CSV-import pågår redan som #${csvResult.importId}`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Handle tool execution calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'search_sanctions') {
      return await handleSearchSanctions(args);
    }

    if (name === 'get_sanction_details') {
      return await handleGetSanctionDetails(args);
    }

    if (name === 'run_database_import') {
      return await handleRunDatabaseImport(args);
    }

    if (name === 'get_override') {
      return await handleGetOverride(args);
    }

    if (name === 'create_override') {
      return await handleCreateOverride(args);
    }

    if (name === 'record_decision') {
      return await handleRecordDecision(args);
    }

    if (name === 'list_decisions_for_entity') {
      return await handleListDecisionsForEntity(args);
    }

    throw new Error(`Okänt verktyg: ${name}`);
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Ett fel uppstod: ${error.message}` }],
      isError: true,
    };
  }
});

/**
 * List available resources (like database stats).
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'sanctions://statistics',
        name: 'Sanktionsdatabas Statistik',
        description: 'Statistik över antalet sparade sanktionsposter fördelat på källa.',
        mimeType: 'application/json',
      },
    ],
  };
});

/**
 * Handles the sanctions://statistics resource read. Exported so it can be
 * unit tested directly (issue #71), mirroring the handleSearchSanctions
 * pattern.
 */
export async function handleReadStatistics() {
  const uri = 'sanctions://statistics';
  try {
    const totalCount = (await db.collection('sanctions').count().get()).data().count;
    const euCount = (await db.collection('sanctions').where('source', '==', 'EU').count().get()).data().count;
    const unCount = (await db.collection('sanctions').where('source', '==', 'UN').count().get()).data().count;
    const usCount = (await db.collection('sanctions').where('source', '==', 'US').count().get()).data().count;
    const pepCount = (await db.collection('sanctions').where('source', '==', 'PEP').count().get()).data().count;

    const statistics = {
      totalRecords: totalCount,
      breakdown: {
        EU: euCount,
        UN: unCount,
        US_OFAC: usCount,
        PEP: pepCount,
      },
      lastUpdated: new Date().toISOString(),
    };

    return {
      contents: [
        {
          uri: uri,
          mimeType: 'application/json',
          text: JSON.stringify(statistics, null, 2),
        },
      ],
    };
  } catch (err: any) {
    throw new Error(`Kunde inte läsa statistikresurs: ${err.message}`);
  }
}

/**
 * Handle reading a resource (like statistics).
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'sanctions://statistics') {
    return await handleReadStatistics();
  }

  throw new Error(`Okänd resurs: ${uri}`);
});

// Run the server using StdioTransport
async function runMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server connected to Stdio transport.');
}

runMcpServer().catch((err) => {
  console.error('Failed to run MCP Server:', err);
  process.exit(1);
});
