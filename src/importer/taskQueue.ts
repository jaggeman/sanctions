import { getFunctions } from 'firebase-admin/functions';
import '../shared/firebase'; // ensures admin.initializeApp() has run first
import { ImportOptions } from './index';

/**
 * Hands a full import off to the `runImportTask` Cloud Tasks-dispatched
 * function (issue #43) instead of running it in-process. Cloud Tasks durably
 * persists the job and retries it independently of this request's own
 * instance, unlike the old fire-and-forget `runImport(...).then()` call this
 * replaces.
 */
export async function enqueueImportTask(options: ImportOptions): Promise<void> {
  await getFunctions().taskQueue('runImportTask').enqueue(options);
}
