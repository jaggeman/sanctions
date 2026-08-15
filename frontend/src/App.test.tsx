import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

describe('App component navigation tabs', () => {
  it('renders the Search tab by default', () => {
    render(<App />);
    expect(screen.getByText('Search Entities')).toBeInTheDocument();
  });

  it('navigates to Official EU Lists tab', () => {
    render(<App />);
    const euTab = screen.getByText('Official EU Lists');
    fireEvent.click(euTab);
    
    // Check if the EU specific content is displayed
    expect(screen.getByText('EU Sanctions Map')).toBeInTheDocument();
    expect(screen.getByText('Consolidated Financial Sanctions')).toBeInTheDocument();
  });

  it('navigates to Help & Manual tab', () => {
    render(<App />);
    const manualTab = screen.getByText('Help & Manual');
    fireEvent.click(manualTab);
    
    // Check if the Manual specific content is displayed
    expect(screen.getByText('User Manual & Help')).toBeInTheDocument();
    expect(screen.getByText('How to Search')).toBeInTheDocument();
    expect(screen.getByText('Uploading Lists')).toBeInTheDocument();
    expect(screen.getByText('Official Sources')).toBeInTheDocument();
  });
});
