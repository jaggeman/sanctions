import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import OfficialSourcesTab from './OfficialSourcesTab';

describe('OfficialSourcesTab', () => {
  it('renders all 5 official sanctions authorities and their primary resources', () => {
    render(<OfficialSourcesTab />);

    // Main header
    expect(screen.getByText(/Official Sanctions Lists & Sources/i)).toBeInTheDocument();

    // European Union (EU)
    expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
    expect(screen.getByText('EU Consolidated Financial Sanctions')).toBeInTheDocument();
    expect(screen.getByText('European Commission Policy')).toBeInTheDocument();

    // United Nations (UN)
    expect(screen.getByText('UN Security Council Consolidated List')).toBeInTheDocument();
    expect(screen.getByText('UN Sanctions Committees Portal')).toBeInTheDocument();

    // United States (US - OFAC)
    expect(screen.getByText('OFAC Sanctions List Search')).toBeInTheDocument();
    expect(screen.getByText('OFAC Specially Designated Nationals (SDN)')).toBeInTheDocument();

    // United Kingdom (UK)
    expect(screen.getByText('The UK Sanctions List (FCDO)')).toBeInTheDocument();
    expect(screen.getByText('OFSI Consolidated Financial Sanctions')).toBeInTheDocument();

    // Switzerland (CH - SECO)
    expect(screen.getByText('SECO SESAM Sanctions Database')).toBeInTheDocument();
    expect(screen.getByText('SECO Embargoes & Sanctions Overview')).toBeInTheDocument();

    // Check key external link URLs
    expect(screen.getByRole('link', { name: /open map/i })).toHaveAttribute(
      'href',
      'https://www.sanctionsmap.eu/#/main',
    );
    expect(screen.getByRole('link', { name: /open eu dataset/i })).toHaveAttribute(
      'href',
      expect.stringContaining('data.europa.eu'),
    );
    expect(screen.getByRole('link', { name: /view un list/i })).toHaveAttribute(
      'href',
      'https://www.un.org/securitycouncil/content/un-sc-consolidated-list',
    );
    expect(screen.getByRole('link', { name: /search ofac/i })).toHaveAttribute(
      'href',
      'https://sanctionssearch.ofac.treas.gov/',
    );
    expect(screen.getByRole('link', { name: /view uk list/i })).toHaveAttribute(
      'href',
      'https://www.gov.uk/government/publications/the-uk-sanctions-list',
    );
    expect(screen.getByRole('link', { name: /open sesam/i })).toHaveAttribute(
      'href',
      'https://www.sesam.search.admin.ch/',
    );
  });
});
