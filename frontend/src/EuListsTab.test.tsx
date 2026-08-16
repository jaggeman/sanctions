import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import EuListsTab from './EuListsTab';

describe('EuListsTab', () => {
  it('renders all three official EU resource links', () => {
    render(<EuListsTab />);

    expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
    expect(screen.getByText('Consolidated Financial Sanctions')).toBeInTheDocument();
    expect(screen.getByText('European Commission Policy')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /open map/i })).toHaveAttribute(
      'href',
      'https://www.sanctionsmap.eu/#/main',
    );
    expect(screen.getByRole('link', { name: /open dataset/i })).toHaveAttribute(
      'href',
      expect.stringContaining('data.europa.eu'),
    );
    expect(screen.getByRole('link', { name: /read policy/i })).toHaveAttribute(
      'href',
      expect.stringContaining('finance.ec.europa.eu'),
    );
  });
});
