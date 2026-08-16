import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Wraps React.lazy with automatic recovery for chunk loading errors (e.g. after a new deployment).
 * When a dynamic import fails (MIME type HTML error / chunk not found / network failure),
 * it forces a single window reload to pick up the latest HTML and chunk hashes.
 * If it still fails after reload, it throws the error so TabErrorBoundary can render fallback UI.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  componentName?: string,
): LazyExoticComponent<T> {
  return lazy(async () => {
    const storageKey = `retry_chunk_${componentName || 'component'}`;
    const hasRefreshed = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(storageKey) : null;

    try {
      const component = await importer();
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(storageKey);
      }
      return component;
    } catch (error) {
      if (!hasRefreshed && typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(storageKey, 'true');
        window.location.reload();
        // Return a never-resolving promise while reload executes to prevent unhandled errors
        return new Promise<{ default: T }>(() => {});
      }
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(storageKey);
      }
      throw error;
    }
  });
}
