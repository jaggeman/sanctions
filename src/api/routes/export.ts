import { Router, Request, Response } from 'express';
import { db } from '../../shared/firebase';
import { SanctionRecord } from '../../shared/types';
import { recordsToCsv } from '../../shared/csvSerializer';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';

export const exportRouter = Router();

/**
 * GET /api/export
 * Exports sanctions data as an RFC 4180 CSV attachment.
 * Supports filtering by source, type, status (active/delisted/all), and importId.
 * Authenticated via session cookie or 'read'-scoped API token.
 */
exportRouter.get('/export', requireAuthOrScope('sanctions:read'), async (req: Request, res: Response): Promise<void> => {
  const { source, type, status, importId } = req.query;

  const sourcesFilter = source && typeof source === 'string'
    ? source.split(',').map((s) => s.trim().toUpperCase())
    : null;

  const typeFilter = type && typeof type === 'string'
    ? type.trim().toLowerCase()
    : null;

  const statusFilter = status && typeof status === 'string'
    ? status.trim().toLowerCase()
    : 'active'; // Default to active records unless explicitly specified

  const targetImportId = importId && typeof importId === 'string'
    ? importId.trim()
    : null;

  try {
    const snapshot = await db.collection('sanctions').get();
    const records: SanctionRecord[] = [];

    snapshot.docs.forEach((doc: any) => {
      const r = doc.data() as SanctionRecord;

      // Firestore doesn't enforce the SanctionRecord type — a corrupted or
      // manually-edited document can be missing required fields at runtime.
      if (!r.source || !r.type) {
        return;
      }

      // Filter by status: 'active', 'delisted', or 'all'
      const recordStatus = r.status || 'active';
      if (statusFilter !== 'all' && recordStatus !== statusFilter) {
        return;
      }

      // Filter by source
      if (sourcesFilter && !sourcesFilter.includes(r.source.toUpperCase())) {
        return;
      }

      // Filter by entity type
      if (typeFilter && r.type.toLowerCase() !== typeFilter) {
        return;
      }

      // Filter by importId
      if (targetImportId && r.firstSeenImport !== targetImportId && r.lastSeenImport !== targetImportId) {
        return;
      }

      records.push(r);
    });

    const csv = recordsToCsv(records);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = targetImportId
      ? `sanctions-import-${targetImportId}-${dateStr}.csv`
      : `sanctions-export-${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (error: any) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
