import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import TabErrorBoundary from './TabErrorBoundary';

describe('TabErrorBoundary', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).location;
    window.location = { ...originalLocation, reload: vi.fn() } as any;
  });

  afterEach(() => {
    window.location = originalLocation as any;
  });

  it('renders children when there is no error', () => {
    render(
      createElement(
        TabErrorBoundary,
        null,
        createElement('div', null, 'Tab Content Normal'),
      ),
    );

    expect(screen.getByText('Tab Content Normal')).toBeInTheDocument();
  });

  it('renders fallback UI with reload button when a chunk/render error is caught', () => {
    // Suppress React boundary console.error in test output
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const CrashingComponent = () => {
      throw new Error('Failed to fetch dynamically imported module: HelpManualTab.js');
    };

    render(
      createElement(
        TabErrorBoundary,
        null,
        createElement(CrashingComponent, null),
      ),
    );

    expect(screen.getByText(/Failed to load tab content/i)).toBeInTheDocument();
    expect(screen.getByText(/A new version of the app may be available/i)).toBeInTheDocument();

    const reloadBtn = screen.getByRole('button', { name: /Reload Application/i });
    expect(reloadBtn).toBeInTheDocument();

    fireEvent.click(reloadBtn);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});
