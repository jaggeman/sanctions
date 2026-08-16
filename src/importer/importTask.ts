import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { runImport, ImportOptions } from './index';
import { markImportApplied, markImportFailed } from './importRecord';

/**
 * The actual import logic run by the Cloud Task (issue #43). Exported
 * separately from the onTaskDispatched wrapper below so it's a plain,
 * directly-testable async function rather than requiring firebase-functions'
 * task-request plumbing in unit tests.
 *
 * Throws on failure rather than swallowing it — an onTaskDispatched handler
 * that throws tells Cloud Tasks to retry per its retryConfig, which is the
 * whole point of moving this off the fire-and-forget in-process call.
 *
 * issue #111: this task is the only place a fetch-triggered import's real
 * outcome is ever known — POST /api/import already returned its 202 and
 * moved on. `data.importId` is only absent for a legacy/manually-enqueued
 * task with no matching audit doc to update; every request through the
 * route always sets one (see src/api/index.ts).
 */
export async function handleImportTask(data: ImportOptions): Promise<void> {
  let result;
  try {
    result = await runImport(data);
  } catch (err: any) {
    if (data.importId) await markImportFailed(data.importId, err.message);
    throw err;
  }

  if (!result.success) {
    const error = result.error || 'Import failed';
    if (data.importId) await markImportFailed(data.importId, error);
    throw new Error(error);
  }

  if (data.importId) {
    const parsed = Object.values(result.importedCounts).reduce((a, b) => a + b, 0);
    await markImportApplied(data.importId, { parsed, uploaded: parsed });
  }
}

export const runImportTask = onTaskDispatched<ImportOptions>(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    retryConfig: { maxAttempts: 3 },
    // Decoupled from `api`'s maxInstances: 1 (issue #16) — this function
    // has nothing to do with the in-memory OTP/session state that pin
    // exists for, so it gets its own independent instance budget.
    rateLimits: { maxConcurrentDispatches: 1 },
  },
  async (request) => {
    await handleImportTask(request.data);
  }
);
