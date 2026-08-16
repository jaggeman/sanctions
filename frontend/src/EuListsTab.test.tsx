import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import EuListsTab from './EuListsTab';

describe('EuListsTab (backward compatibility test)', () => {
  it('renders official resource links including EU and international sources', () => {
    render(<EuListsTab />);

    expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
    expect(screen.getByText('EU Consolidated Financial Sanctions')).toBeInTheDocument();
    expect(screen.getByText('European Commission Policy')).toBeInTheDocument();
    expect(screen.getByText('UN Security Council Consolidated List')).toBeInTheDocument();
    expect(screen.getByText('OFAC Sanctions List Search')).toBeInTheDocument();
    expect(screen.getByText('The UK Sanctions List (FCDO)')).toBeInTheDocument();
    expect(screen.getByText('SECO SESAM Sanctions Database')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /open map/i })).toHaveAttribute(
      'href',
      'https://www.sanctionsmap.eu/#/main',
    );
    expect(screen.getByRole('link', { name: /open eu dataset/i })).toHaveAttribute(
      'href',
      expect.stringContaining('data.europa.eu'),
    );
    expect(screen.getByRole('link', { name: /read policy/i })).toHaveAttribute(
      'href',
      expect.stringContaining('finance.ec.europa.eu'),
    );
  });
});
