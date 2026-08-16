import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lazyWithRetry } from './lazyWithRetry';
import React, { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

describe('lazyWithRetry', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    delete (window as any).location;
    window.location = { ...originalLocation, reload: vi.fn() } as any;
  });

  afterEach(() => {
    window.location = originalLocation as any;
    sessionStorage.clear();
  });

  it('renders successfully on first try when import succeeds', async () => {
    const DummyComponent = () => createElement('div', null, 'Dummy Content');
    const importer = vi.fn().mockResolvedValue({ default: DummyComponent });

    const LazyComp = lazyWithRetry(importer, 'Dummy');

    render(
      createElement(
        React.Suspense,
        { fallback: createElement('div', null, 'Loading...') },
        createElement(LazyComp, null),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Dummy Content')).toBeInTheDocument();
    });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('reloads window once when dynamic import fails (e.g. chunk hash mismatch after deploy)', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('Failed to fetch dynamically imported module'));

    const LazyComp = lazyWithRetry(importer, 'FailedChunk');

    render(
      createElement(
        React.Suspense,
        { fallback: createElement('div', null, 'Loading...') },
        createElement(LazyComp, null),
      ),
    );

    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalledTimes(1);
    });
    expect(sessionStorage.getItem('retry_chunk_FailedChunk')).toBe('true');
  });

  it('throws the error if import still fails after reload flag was already set', async () => {
    sessionStorage.setItem('retry_chunk_FailedChunk', 'true');
    const importer = vi.fn().mockRejectedValue(new Error('Permanent chunk failure'));

    const LazyComp = lazyWithRetry(importer, 'FailedChunk');

    let capturedError: any = null;
    class CatchBoundary extends React.Component<{ children: any }, { hasError: boolean }> {
      state = { hasError: false };
      static getDerivedStateFromError(error: any) {
        capturedError = error;
        return { hasError: true };
      }
      render() {
        return this.state.hasError ? createElement('div', null, 'Error caught') : this.props.children;
      }
    }

    render(
      createElement(
        CatchBoundary,
        null,
        createElement(
          React.Suspense,
          { fallback: createElement('div', null, 'Loading...') },
          createElement(LazyComp, null),
        ),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Error caught')).toBeInTheDocument();
    });
    expect(capturedError?.message).toBe('Permanent chunk failure');
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
