import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HelpManualTab from './HelpManualTab';

describe('HelpManualTab', () => {
  it('renders a section for every tab in the app', () => {
    render(<HelpManualTab />);

    expect(screen.getByText('How to Search')).toBeInTheDocument();
    expect(screen.getByText('Uploading Lists')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import History' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Official Sources' })).toBeInTheDocument();
    expect(screen.getByText('Managing API Tokens')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Drift Status' })).toBeInTheDocument();
  });

  it('documents fuzzy match scoring, non-Latin search, and duplicate-upload behavior', () => {
    render(<HelpManualTab />);

    expect(screen.getByText(/match score/i)).toBeInTheDocument();
    expect(screen.getByText(/non-Latin/i)).toBeInTheDocument();
    expect(screen.getAllByText(/duplicate/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Import History/i).length).toBeGreaterThan(0);
  });

  it('documents CSV export from search results and import history', () => {
    render(<HelpManualTab />);

    expect(screen.getByText(/Export Results \(CSV\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/CSV/i).length).toBeGreaterThan(1);
  });

  it('documents all five official source lists', () => {
    render(<HelpManualTab />);

    expect(screen.getByText(/Swiss SECO/i)).toBeInTheDocument();
    expect(screen.getByText(/FCDO\/OFSI/i)).toBeInTheDocument();
  });
});
