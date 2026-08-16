import React, { useState, useMemo } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  Paper,
  Chip,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Alert,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';

export interface McpClientGuideProps {
  initialToken?: string;
  baseUrl?: string;
}

export default function McpClientGuide({ initialToken = '', baseUrl: propBaseUrl }: McpClientGuideProps) {
  const defaultBaseUrl = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'https://sanctions-app-dev-01.web.app';

  const [activeTab, setActiveTab] = useState(0);
  const [token, setToken] = useState(initialToken);
  const [baseUrl, setBaseUrl] = useState(propBaseUrl || defaultBaseUrl);
  const [copied, setCopied] = useState(false);

  // Sync if initialToken changes from parent (e.g. newly minted token)
  React.useEffect(() => {
    if (initialToken) {
      setToken(initialToken);
    }
  }, [initialToken]);

  React.useEffect(() => {
    if (propBaseUrl) {
      setBaseUrl(propBaseUrl);
    }
  }, [propBaseUrl]);

  const effectiveToken = token.trim() || '<YOUR_API_TOKEN>';
  const effectiveBaseUrl = baseUrl.trim() || 'https://sanctions-app-dev-01.web.app';

  const configs = useMemo(() => {
    const claudeDesktopConfig = {
      mcpServers: {
        sanctions: {
          command: 'node',
          args: ['<path-to-sanctions>/dist/mcp/index.js'],
          env: {
            MCP_API_BASE_URL: effectiveBaseUrl,
            MCP_API_TOKEN: effectiveToken,
          },
        },
      },
    };

    const cursorConfig = {
      mcpServers: {
        sanctions: {
          command: 'node',
          args: ['<path-to-sanctions>/dist/mcp/index.js'],
          env: {
            MCP_API_BASE_URL: effectiveBaseUrl,
            MCP_API_TOKEN: effectiveToken,
          },
        },
      },
    };

    const geminiConfig = {
      mcpServers: {
        sanctions: {
          command: 'node',
          args: ['<path-to-sanctions>/dist/mcp/index.js'],
          env: {
            MCP_API_BASE_URL: effectiveBaseUrl,
            MCP_API_TOKEN: effectiveToken,
          },
        },
      },
    };

    const claudeCliCommand = `claude mcp add sanctions --env MCP_API_BASE_URL=${effectiveBaseUrl} --env MCP_API_TOKEN=${effectiveToken} -- node <path-to-sanctions>/dist/mcp/index.js`;

    const chatGptRestInfo = `# 1. Custom GPT / OpenAI Actions Authentication
Header: Authorization
Value: Bearer ${effectiveToken}

# 2. OpenAPI Specification URL
${effectiveBaseUrl}/api/docs

# 3. Direct cURL Example (Search Entities)
curl -X GET "${effectiveBaseUrl}/api/search?query=Putin&limit=5" \\
  -H "Authorization: Bearer ${effectiveToken}" \\
  -H "Accept: application/json"`;

    return {
      claudeDesktop: JSON.stringify(claudeDesktopConfig, null, 2),
      claudeCli: claudeCliCommand,
      cursor: JSON.stringify(cursorConfig, null, 2),
      gemini: JSON.stringify(geminiConfig, null, 2),
      chatGpt: chatGptRestInfo,
    };
  }, [effectiveBaseUrl, effectiveToken]);

  const currentSnippet = useMemo(() => {
    switch (activeTab) {
      case 0:
        return configs.claudeDesktop;
      case 1:
        return configs.claudeCli;
      case 2:
        return configs.cursor;
      case 3:
        return configs.gemini;
      case 4:
        return configs.chatGpt;
      default:
        return configs.claudeDesktop;
    }
  }, [activeTab, configs]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  return (
    <Card sx={{ mt: 4, p: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2, mb: 2 }}>
          <Box>
            <Typography variant="h5" gutterBottom>
              Connect to AI Clients (MCP & API)
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Use Model Context Protocol (MCP) or direct REST API tokens to connect Anthropic Claude, Google Gemini, Cursor, and ChatGPT to Sanctions Intelligence.
            </Typography>
          </Box>
          <Button
            variant="contained"
            color={copied ? 'success' : 'primary'}
            onClick={handleCopy}
            startIcon={copied ? <CheckIcon /> : <ContentCopyIcon />}
            aria-label="Copy Configuration"
          >
            {copied ? 'Copied!' : 'Copy Configuration'}
          </Button>
        </Box>

        {/* Configuration Parameters */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
          <TextField
            label="API Token"
            placeholder="Paste or enter token (e.g. sanc_...)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            sx={{ flex: 1, minWidth: 280 }}
            size="small"
            helperText="Token will be substituted into the client config below"
          />
          <TextField
            label="API Base URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            sx={{ flex: 1, minWidth: 280 }}
            size="small"
            helperText="API server host URL"
          />
        </Box>

        {/* Platform Selection Tabs */}
        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
          <Tabs
            value={activeTab}
            onChange={(_, val) => {
              setActiveTab(val);
              setCopied(false);
            }}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="Claude Desktop" />
            <Tab label="Claude Code CLI" />
            <Tab label="Cursor / VS Code" />
            <Tab label="Gemini / Antigravity" />
            <Tab label="ChatGPT & REST" />
          </Tabs>
        </Box>

        {/* Tab Instructions */}
        {activeTab === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>Claude Desktop setup:</strong> Paste this snippet into your <code>claude_desktop_config.json</code> file.
              <br />
              • <strong>macOS:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
              <br />
              • <strong>Windows:</strong> <code>%APPDATA%\Claude\claude_desktop_config.json</code>
            </Typography>
          </Alert>
        )}

        {activeTab === 1 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>Claude Code CLI setup:</strong> Run this command in your terminal to register the sanctions MCP server.
            </Typography>
          </Alert>
        )}

        {activeTab === 2 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>Cursor / VS Code setup:</strong> Add this configuration to your project's <code>.cursor/mcp.json</code> or VS Code MCP settings.
            </Typography>
          </Alert>
        )}

        {activeTab === 3 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>Google Gemini & Antigravity setup:</strong> Add this to your Antigravity / Gemini MCP settings (<code>mcp_config.json</code>).
            </Typography>
          </Alert>
        )}

        {activeTab === 4 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2">
              <strong>ChatGPT & Custom GPT Actions setup:</strong> In ChatGPT Custom GPTs, import the OpenAPI schema and set Authentication type to <em>API Key</em> &rarr; <em>Bearer</em>.
            </Typography>
          </Alert>
        )}

        {/* Code Snippet Box */}
        <Paper
          variant="outlined"
          sx={{
            p: 2,
            backgroundColor: 'grey.900',
            color: 'grey.100',
            borderRadius: 1,
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            overflowX: 'auto',
            position: 'relative',
          }}
        >
          <pre
            data-testid="mcp-config-snippet"
            style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {currentSnippet}
          </pre>
        </Paper>

        {/* Exposed Tools Table */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }} gutterBottom>
            Available Tools Exposed to AI Assistants
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tool Name</TableCell>
                <TableCell>Required Scope</TableCell>
                <TableCell>Description</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow hover>
                <TableCell><code>search_sanctions</code></TableCell>
                <TableCell><Chip label="read" size="small" color="primary" variant="outlined" /></TableCell>
                <TableCell>Search individuals and entities across EU, UN, US (OFAC), UK and PEP lists.</TableCell>
              </TableRow>
              <TableRow hover>
                <TableCell><code>get_sanction_details</code></TableCell>
                <TableCell><Chip label="read" size="small" color="primary" variant="outlined" /></TableCell>
                <TableCell>Fetch complete sanction and biographical record details by unique ID.</TableCell>
              </TableRow>
              <TableRow hover>
                <TableCell><code>get_override</code></TableCell>
                <TableCell><Chip label="read" size="small" color="primary" variant="outlined" /></TableCell>
                <TableCell>Check active overrides for an entity.</TableCell>
              </TableRow>
              <TableRow hover>
                <TableCell><code>run_database_import</code></TableCell>
                <TableCell><Chip label="write" size="small" color="secondary" variant="outlined" /></TableCell>
                <TableCell>Trigger download and import of official sanction list updates.</TableCell>
              </TableRow>
              <TableRow hover>
                <TableCell><code>create_override</code></TableCell>
                <TableCell><Chip label="write" size="small" color="secondary" variant="outlined" /></TableCell>
                <TableCell>Create or update custom entity status overrides.</TableCell>
              </TableRow>
              <TableRow hover>
                <TableCell><code>record_decision</code></TableCell>
                <TableCell><Chip label="write" size="small" color="secondary" variant="outlined" /></TableCell>
                <TableCell>Record audit decisions (clear / confirm match) on screening results.</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Box>
      </CardContent>
    </Card>
  );
}
