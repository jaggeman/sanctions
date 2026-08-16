import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HelpManualTab from './HelpManualTab';

describe('HelpManualTab', () => {
  it('renders all four help sections', () => {
    render(<HelpManualTab />);

    expect(screen.getByText('How to Search')).toBeInTheDocument();
    expect(screen.getByText('Uploading Lists')).toBeInTheDocument();
    expect(screen.getByText('Managing API Tokens')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Official Sources' })).toBeInTheDocument();
  });

  it('documents fuzzy match scoring, non-Latin search, and duplicate-upload behavior', () => {
    render(<HelpManualTab />);

    expect(screen.getByText(/match score/i)).toBeInTheDocument();
    expect(screen.getByText(/non-Latin/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicate/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Import History/i).length).toBeGreaterThan(0);
  });
});
