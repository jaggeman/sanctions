import express from 'express';
import cors from 'cors';
import * as functions from 'firebase-functions';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import multer from 'multer';
import * as swaggerUi from 'swagger-ui-express';
import * as admin from 'firebase-admin';
import { db } from '../shared/firebase';
import { normalizeText } from '../importer/uploader';
import { runImport } from '../importer';
import { SanctionRecord } from '../shared/types';
import { tokensRouter } from './routes/tokens';

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: os.tmpdir() });

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Load OpenAPI Specification
const openApiSpecPath = path.resolve(__dirname, 'openapi.json');
let openApiSpec = {};
try {
  openApiSpec = fs.readJsonSync(openApiSpecPath);
} catch (error) {
  console.error('Failed to load openapi.json. Run npm run build or verify path.');
}

// Swagger UI Route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Raw OpenAPI JSON endpoint
app.get('/openapi.json', (req, res) => {
  res.json(openApiSpec);
});

// Admin: API token management (create / list / revoke)
// NOTE: not yet gated by admin authentication — tracked in issue #17
app.use('/api/admin/tokens', tokensRouter);

/**
 * GET /api/search
 * Search sanctions by name/alias token matching, source, or type
 */
app.get('/api/search', async (req, res): Promise<any> => {
  const { q, source, type, limit } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  const normalizedQuery = normalizeText(q);
  const queryTokens = normalizedQuery.split(' ').filter(token => token.length >= 2);

  if (queryTokens.length === 0) {
    return res.json([]); // Return empty list if query is too short
  }

  const requestedLimit = Math.min(parseInt(limit as string) || 20, 100);
  const sourcesFilter = source ? (source as string).split(',').map(s => s.trim().toUpperCase()) : null;
  const typeFilter = type ? (type as string).trim().toLowerCase() : null;

  try {
    const sanctionsCollection = db.collection('sanctions');
    
    // Firestore only supports one array-contains per query.
    // We query on the FIRST token, then filter remaining tokens in-memory.
    const firstToken = queryTokens[0];
    let query: admin.firestore.Query = sanctionsCollection.where('searchNames', 'array-contains', firstToken);

    // Apply type filter directly in DB query if provided
    if (typeFilter) {
      query = query.where('type', '==', typeFilter);
    }

    // Since we need to perform in-memory filtering for additional name tokens,
    // we fetch a slightly larger chunk (up to 500 documents) to ensure we don't miss matches.
    const snapshot = await query.limit(500).get();
    
    let results: SanctionRecord[] = [];
    
    snapshot.forEach((doc: any) => {
      const record = doc.data() as SanctionRecord;
      
      // 1. Verify in-memory filters for other tokens (e.g. searching "vladimir putin" matches both tokens)
      const matchesAllTokens = queryTokens.every(token => 
        record.searchNames.includes(token) || 
        normalizeText(record.primaryName).includes(token)
      );

      if (!matchesAllTokens) return;

      // 2. Filter by source (if specified)
      if (sourcesFilter && !sourcesFilter.includes(record.source.toUpperCase())) {
        return;
      }

      results.push(record);
    });

    // Slice results to the requested limit
    res.json(results.slice(0, requestedLimit));

  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/sanctions/:id
 * Retrieve detail record by ID
 */
app.get('/api/sanctions/:id', async (req, res): Promise<any> => {
  const { id } = req.params;

  try {
    const doc = await db.collection('sanctions').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: `Sanction record with ID ${id} not found.` });
    }
    res.json(doc.data());
  } catch (error: any) {
    console.error('Get details error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/import
 * Trigger background import process
 */
app.post('/api/import', async (req, res): Promise<any> => {
  const { sources, csvPath } = req.body;

  // Validate sources if provided
  if (sources && !Array.isArray(sources)) {
    return res.status(400).json({ error: '"sources" must be an array.' });
  }

  // Trigger import in the background
  console.log('Import triggered via REST API. Starting background run...');
  
  runImport({
    sources: sources,
    csvPath: csvPath,
    csvSource: 'PEP',
    csvSeparator: ';',
  })
    .then((result) => {
      console.log('API Background Import finished:', result);
    })
    .catch((err) => {
      console.error('API Background Import failed:', err);
    });

  // Accept request and return immediately (202 Accepted)
  res.status(202).json({
    status: 'import_started',
    message: 'The import process has been started in the background. Check server logs for progress.',
  });
});

/**
 * POST /api/upload
 * Upload a CSV or XML file for processing
 */
app.post('/api/upload', upload.single('file'), async (req, res): Promise<any> => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { source } = req.body; // e.g. "PEP", "EU", "UN"
  const uploadedPath = req.file.path;

  console.log(`Received uploaded file for source ${source}: ${uploadedPath}`);
  
  // Trigger background import with the uploaded file path
  runImport({
    sources: source ? [source] : [],
    csvPath: uploadedPath,
    csvSource: source || 'MANUAL_CSV',
    csvSeparator: ';',
  })
    .then(() => {
      console.log('Upload Background Import finished.');
      fs.remove(uploadedPath).catch(e => console.error('Failed to cleanup temp file', e));
    })
    .catch((err) => {
      console.error('Upload Background Import failed:', err);
      fs.remove(uploadedPath).catch(e => console.error('Failed to cleanup temp file', e));
    });

  res.status(202).json({
    status: 'upload_received',
    message: 'File received and import process started.',
  });
});

// Export Express App as a Firebase Cloud Function
export const api = functions.https.onRequest(app);
