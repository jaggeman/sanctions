import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { runImport, ImportOptions } from './index';

/**
 * The actual import logic run by the Cloud Task (issue #43). Exported
 * separately from the onTaskDispatched wrapper below so it's a plain,
 * directly-testable async function rather than requiring firebase-functions'
 * task-request plumbing in unit tests.
 *
 * Throws on failure rather than swallowing it — an onTaskDispatched handler
 * that throws tells Cloud Tasks to retry per its retryConfig, which is the
 * whole point of moving this off the fire-and-forget in-process call.
 */
export async function handleImportTask(data: ImportOptions): Promise<void> {
  const result = await runImport(data);
  if (!result.success) {
    throw new Error(result.error || 'Import failed');
  }
}

export const runImportTask = onTaskDispatched<ImportOptions>(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    retryConfig: { maxAttempts: 3 },
    // Its own independent instance/concurrency budget, separate from `api`
    // (which is no longer instance-pinned either, per issue #101) — one
    // import running at a time avoids two concurrent runs racing on the
    // same collections.
    rateLimits: { maxConcurrentDispatches: 1 },
  },
  async (request) => {
    await handleImportTask(request.data);
  }
);
