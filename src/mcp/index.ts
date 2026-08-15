import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as admin from 'firebase-admin';
import { db } from '../shared/firebase';
import { normalizeText } from '../importer/uploader';
import { runImport } from '../importer';
import { SanctionRecord } from '../shared/types';

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
    ],
  };
});

/**
 * Handle tool execution calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'search_sanctions') {
      const queryStr = String(args?.query || '');
      const sourceStr = String(args?.source || '');
      const typeStr = String(args?.type || '');
      const limitVal = Number(args?.limit || 10);

      const normalized = normalizeText(queryStr);
      const tokens = normalized.split(' ').filter(t => t.length >= 2);

      if (tokens.length === 0) {
        return {
          content: [{ type: 'text', text: 'Sökordet måste vara minst 2 tecken långt.' }],
        };
      }

      const sanctionsCollection = db.collection('sanctions');
      const firstToken = tokens[0];
      let query: admin.firestore.Query = sanctionsCollection.where('searchNames', 'array-contains', firstToken);

      if (typeStr) {
        query = query.where('type', '==', typeStr);
      }

      const snapshot = await query.limit(300).get();
      const results: SanctionRecord[] = [];
      const sourcesFilter = sourceStr ? sourceStr.split(',').map(s => s.trim().toUpperCase()) : null;

      snapshot.forEach((doc: any) => {
        const record = doc.data() as SanctionRecord;
        const matchesAll = tokens.every(token => 
          record.searchNames.includes(token) || 
          normalizeText(record.primaryName).includes(token)
        );

        if (!matchesAll) return;
        if (sourcesFilter && !sourcesFilter.includes(record.source.toUpperCase())) return;

        results.push(record);
      });

      const sliced = results.slice(0, limitVal);
      if (sliced.length === 0) {
        return {
          content: [{ type: 'text', text: `Inga sanktioner matchade din sökning: "${queryStr}"` }],
        };
      }

      // Format results cleanly for the LLM
      const formatted = sliced.map(r => {
        const aliasStr = r.aliases.length > 0 ? ` (Alias: ${r.aliases.join(', ')})` : '';
        const dobStr = r.datesOfBirth ? ` | DOB: ${r.datesOfBirth.join(', ')}` : '';
        const reasonStr = r.sanctionReason ? ` | Orsak: ${r.sanctionReason.substring(0, 100)}${r.sanctionReason.length > 100 ? '...' : ''}` : '';
        return `[${r.id}] ${r.primaryName}${aliasStr} - Källa: ${r.source} (${r.type})${dobStr}${reasonStr}`;
      }).join('\n');

      return {
        content: [{ type: 'text', text: `Hittade ${results.length} träffar (visar de första ${sliced.length}):\n\n${formatted}` }],
      };
    }

    if (name === 'get_sanction_details') {
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

    if (name === 'run_database_import') {
      const sources = args?.sources as ('EU' | 'UN' | 'US')[] | undefined;
      const csvPath = args?.csvPath as string | undefined;

      // Run import synchronously so we can return the result to the caller
      const result = await runImport({
        sources,
        csvPath,
      });

      if (result.success) {
        return {
          content: [{
            type: 'text',
            text: `Import slutförd framgångsrikt!\nAntal poster importerade per källa:\n${JSON.stringify(result.importedCounts, null, 2)}`,
          }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `Import misslyckades: ${result.error}` }],
          isError: true,
        };
      }
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
 * Handle reading a resource (like statistics).
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'sanctions://statistics') {
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
