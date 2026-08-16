import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import McpClientGuide from './McpClientGuide';

describe('McpClientGuide component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders title, description and client platform tabs', () => {
    render(<McpClientGuide initialToken="sanc_test_token_123" baseUrl="https://sanctions-app-dev-01.web.app" />);

    expect(screen.getByText(/Connect to AI Clients/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Claude Desktop/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Claude Code/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cursor/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Gemini/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /ChatGPT/i })).toBeInTheDocument();
  });

  it('displays Claude Desktop config snippet containing token and baseUrl by default', () => {
    render(<McpClientGuide initialToken="sanc_test_token_123" baseUrl="https://sanctions-app-dev-01.web.app" />);

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet).toBeInTheDocument();
    expect(codeSnippet.textContent).toContain('"MCP_API_BASE_URL": "https://sanctions-app-dev-01.web.app"');
    expect(codeSnippet.textContent).toContain('"MCP_API_TOKEN": "sanc_test_token_123"');
    expect(codeSnippet.textContent).toContain('"mcpServers"');
  });

  it('switches to Claude Code CLI tab and shows CLI add command', () => {
    render(<McpClientGuide initialToken="sanc_secret_abc" baseUrl="https://api.example.com" />);

    const cliTab = screen.getByRole('tab', { name: /Claude Code/i });
    fireEvent.click(cliTab);

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet.textContent).toContain('claude mcp add sanctions');
    expect(codeSnippet.textContent).toContain('MCP_API_TOKEN=sanc_secret_abc');
    expect(codeSnippet.textContent).toContain('MCP_API_BASE_URL=https://api.example.com');
  });

  it('switches to Cursor / VS Code tab and displays config instructions', () => {
    render(<McpClientGuide initialToken="sanc_cursor_token" baseUrl="https://api.example.com" />);

    const cursorTab = screen.getByRole('tab', { name: /Cursor/i });
    fireEvent.click(cursorTab);

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet.textContent).toContain('"MCP_API_TOKEN": "sanc_cursor_token"');
    expect(screen.getByText(/\.cursor\/mcp\.json/i)).toBeInTheDocument();
  });

  it('switches to Gemini / Antigravity tab and displays settings config', () => {
    render(<McpClientGuide initialToken="sanc_gemini_token" baseUrl="https://api.example.com" />);

    const geminiTab = screen.getByRole('tab', { name: /Gemini/i });
    fireEvent.click(geminiTab);

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet.textContent).toContain('"MCP_API_TOKEN": "sanc_gemini_token"');
    expect(screen.getByText(/Google Gemini & Antigravity setup/i)).toBeInTheDocument();
  });

  it('switches to ChatGPT / REST tab and displays API / Bearer authentication details', () => {
    render(<McpClientGuide initialToken="sanc_gpt_token" baseUrl="https://api.example.com" />);

    const gptTab = screen.getByRole('tab', { name: /ChatGPT/i });
    fireEvent.click(gptTab);

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet.textContent).toContain('Authorization: Bearer sanc_gpt_token');
    expect(screen.getByText(/Custom GPT Actions/i)).toBeInTheDocument();
  });

  it('copies configuration to clipboard when Copy button is clicked', async () => {
    render(<McpClientGuide initialToken="sanc_copy_token" baseUrl="https://sanctions-app-dev-01.web.app" />);

    const copyBtn = screen.getByRole('button', { name: /Copy Configuration|Copy Snippet|Copy/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/Copied/i)).toBeInTheDocument();
    });
  });

  it('allows user to customize token or base URL via input fields', () => {
    render(<McpClientGuide initialToken="" baseUrl="https://sanctions-app-dev-01.web.app" />);

    const tokenInput = screen.getByLabelText(/API Token/i);
    fireEvent.change(tokenInput, { target: { value: 'sanc_custom_999' } });

    const codeSnippet = screen.getByTestId('mcp-config-snippet');
    expect(codeSnippet.textContent).toContain('"MCP_API_TOKEN": "sanc_custom_999"');
  });

  it('lists exposed tools available to AI assistants', () => {
    render(<McpClientGuide initialToken="sanc_token" />);

    expect(screen.getByText(/search_sanctions/i)).toBeInTheDocument();
    expect(screen.getByText(/get_sanction_details/i)).toBeInTheDocument();
  });
});
