import { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Alert,
  CircularProgress,
  Tooltip,
  Paper,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { apiFetch } from './apiFetch';
import McpClientGuide from './components/McpClientGuide';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

type AccessState = 'checking' | 'admin' | 'denied';

interface ApiToken {
  id: string;
  name: string;
  tokenPreview: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '180d', label: '180 days' },
  { value: '365d', label: '1 year' },
];

function isExpired(token: ApiToken): boolean {
  return !!token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now();
}

const GRANULAR_SCOPE_OPTIONS = [
  { id: 'sanctions:read', label: 'Search & Sanctions (Read)', group: 'Screening' },
  { id: 'custom:read', label: 'Custom Records (Read)', group: 'Watchlists' },
  { id: 'custom:write', label: 'Custom Records (Write)', group: 'Watchlists' },
  { id: 'overrides:read', label: 'Overrides (Read)', group: 'Data Quality' },
  { id: 'overrides:write', label: 'Overrides (Write)', group: 'Data Quality' },
  { id: 'decisions:read', label: 'Compliance Decisions (Read)', group: 'Compliance' },
  { id: 'decisions:write', label: 'Compliance Decisions (Write)', group: 'Compliance' },
  { id: 'imports:read', label: 'Imports (Read)', group: 'Pipelines' },
  { id: 'imports:write', label: 'Imports & Uploads (Write)', group: 'Pipelines' },
  { id: 'system:read', label: 'System Diagnostics (Read)', group: 'System' },
];

// One row per resource, Read/Write collapsed into columns — derived from
// GRANULAR_SCOPE_OPTIONS so the table can't drift from the actual scope ids.
interface GranularScopeRow {
  resource: string;
  readId?: string;
  writeId?: string;
}

const GRANULAR_SCOPE_ROWS: GranularScopeRow[] = GRANULAR_SCOPE_OPTIONS.reduce<GranularScopeRow[]>((rows, opt) => {
  const resource = opt.label.replace(/\s*\((Read|Write)\)$/, '');
  let row = rows.find((r) => r.resource === resource);
  if (!row) {
    row = { resource };
    rows.push(row);
  }
  if (opt.id.endsWith(':read')) row.readId = opt.id;
  else if (opt.id.endsWith(':write')) row.writeId = opt.id;
  return rows;
}, []);

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

export default function ApiTokensTab() {
  const [accessState, setAccessState] = useState<AccessState>('checking');
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [scopeRead, setScopeRead] = useState(true);
  const [scopeWrite, setScopeWrite] = useState(false);
  const [useGranular, setUseGranular] = useState(false);
  const [selectedGranularScopes, setSelectedGranularScopes] = useState<string[]>(['sanctions:read']);
  const [expiresIn, setExpiresIn] = useState('never');
  const [creating, setCreating] = useState(false);

  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [activeGuideToken, setActiveGuideToken] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/tokens');
      if (res.status === 401) throw new Error(SESSION_EXPIRED_MESSAGE);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      setTokens(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error(err);
      setError(err.message === SESSION_EXPIRED_MESSAGE ? SESSION_EXPIRED_MESSAGE : 'Could not load API tokens.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/auth/session');
        if (!res.ok) {
          setAccessState('denied');
          return;
        }
        const data = await res.json();
        setAccessState(data.isAdmin ? 'admin' : 'denied');
      } catch (err) {
        console.error('Failed to check admin status', err);
        setAccessState('denied');
      }
    })();
  }, []);

  useEffect(() => {
    if (accessState === 'admin') loadTokens();
  }, [accessState, loadTokens]);

  const toggleGranularScope = (scopeId: string) => {
    setSelectedGranularScopes((prev) =>
      prev.includes(scopeId) ? prev.filter((s) => s !== scopeId) : [...prev, scopeId]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    const scopes = useGranular
      ? selectedGranularScopes
      : ([scopeRead && 'read', scopeWrite && 'write'].filter(Boolean) as string[]);

    if (scopes.length === 0) {
      setError('Select at least one scope.');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes, expiresIn }),
      });
      if (res.status === 401) throw new Error(SESSION_EXPIRED_MESSAGE);
      if (!res.ok) {
        let serverError: string | undefined;
        try {
          const body = await res.json();
          serverError = body?.error;
        } catch {
          // Non-JSON response body (e.g. 502 Bad Gateway HTML)
        }
        throw new Error(serverError || 'Failed to create token.');
      }
      const data = await res.json();

      setRevealedToken(data.token);
      setActiveGuideToken(data.token);
      setName('');
      setScopeRead(true);
      setScopeWrite(false);
      setSelectedGranularScopes(['sanctions:read']);
      setExpiresIn('never');
      await loadTokens();
    } catch (err: any) {
      console.error(err);
      setError(
        err.message === SESSION_EXPIRED_MESSAGE
          ? SESSION_EXPIRED_MESSAGE
          : err.message && !err.message.includes('JSON') && !err.message.includes('fetch')
            ? err.message
            : 'Failed to create token.',
      );
    }
    setCreating(false);
  };

  const handleRevoke = async () => {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      const res = await apiFetch(`/api/admin/tokens/${pendingRevoke.id}/revoke`, { method: 'POST' });
      if (res.status === 401) throw new Error(SESSION_EXPIRED_MESSAGE);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setPendingRevoke(null);
      await loadTokens();
    } catch (err: any) {
      console.error(err);
      setError(err.message === SESSION_EXPIRED_MESSAGE ? SESSION_EXPIRED_MESSAGE : 'Failed to revoke token.');
    }
    setRevoking(false);
  };

  const copyRevealedToken = async () => {
    if (!revealedToken) return;
    try {
      await navigator.clipboard.writeText(revealedToken);
      setCopied(true);
    } catch (err) {
      console.error('Clipboard copy failed', err);
    }
  };

  if (accessState === 'checking') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (accessState === 'denied') {
    return (
      <Alert severity="warning" sx={{ mt: 2 }}>
        API token management is restricted to admins. Ask an existing admin to grant you access if you believe this is a mistake.
      </Alert>
    );
  }

  return (
    <Box>
      <Card sx={{ mb: 4, p: 2 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Create API Token
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The full token is shown once, right after creation. Only a hash is stored — if it's lost, revoke it and create a new one.
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField
                label="Token name"
                placeholder="e.g. CI pipeline"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
                sx={{ minWidth: 260 }}
              />
              <TextField
                select
                label="Expires"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                disabled={creating}
                slotProps={{ select: { native: true } }}
                sx={{ minWidth: 140 }}
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </TextField>
              {!useGranular ? (
                <FormGroup row>
                  <FormControlLabel
                    control={<Checkbox checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} disabled={creating} />}
                    label="Read"
                  />
                  <FormControlLabel
                    control={<Checkbox checked={scopeWrite} onChange={(e) => setScopeWrite(e.target.checked)} disabled={creating} />}
                    label="Write"
                  />
                </FormGroup>
              ) : null}
              <Button
                variant="outlined"
                size="small"
                onClick={() => setUseGranular(!useGranular)}
                disabled={creating}
              >
                {useGranular ? 'Simple Scopes (Read/Write)' : 'Granular Permissions'}
              </Button>
              <Button
                variant="contained"
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                startIcon={creating ? <CircularProgress size={18} color="inherit" /> : undefined}
              >
                Create Token
              </Button>
            </Box>

            {useGranular && (
              <Paper variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Granular Resource Scopes (Least Privilege Access):
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Resource</TableCell>
                      <TableCell align="center">Read</TableCell>
                      <TableCell align="center">Write</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {GRANULAR_SCOPE_ROWS.map((row) => (
                      <TableRow key={row.resource}>
                        <TableCell>{row.resource}</TableCell>
                        <TableCell align="center">
                          {row.readId && (
                            <Checkbox
                              size="small"
                              checked={selectedGranularScopes.includes(row.readId)}
                              onChange={() => toggleGranularScope(row.readId!)}
                              disabled={creating}
                              slotProps={{ input: { 'aria-label': `${row.resource} (Read)` } }}
                            />
                          )}
                        </TableCell>
                        <TableCell align="center">
                          {row.writeId && (
                            <Checkbox
                              size="small"
                              checked={selectedGranularScopes.includes(row.writeId)}
                              onChange={() => toggleGranularScope(row.writeId!)}
                              disabled={creating}
                              slotProps={{ input: { 'aria-label': `${row.resource} (Write)` } }}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            )}
          </Box>

          {error && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card sx={{ p: 2, mb: 4 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Existing Tokens
          </Typography>

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : tokens.length === 0 ? (
            <Typography variant="body1" color="text.secondary" sx={{ mt: 2 }}>
              No tokens yet. Create one above to get started.
            </Typography>
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Token</TableCell>
                    <TableCell>Scopes</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Last used</TableCell>
                    <TableCell>Expires</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tokens.map((t) => (
                    <TableRow key={t.id} hover>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>
                        <code>{t.tokenPreview}</code>
                      </TableCell>
                      <TableCell>
                        {t.scopes.map((s) => (
                          <Chip key={s} label={s} size="small" sx={{ mr: 0.5 }} color={s === 'write' ? 'secondary' : 'primary'} variant="outlined" />
                        ))}
                      </TableCell>
                      <TableCell>{formatDate(t.createdAt)}</TableCell>
                      <TableCell>{formatDate(t.lastUsedAt)}</TableCell>
                      <TableCell>{formatDate(t.expiresAt)}</TableCell>
                      <TableCell>
                        <Chip
                          label={t.revoked ? 'Revoked' : isExpired(t) ? 'Expired' : 'Active'}
                          size="small"
                          color={t.revoked ? 'default' : isExpired(t) ? 'warning' : 'success'}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title="View MCP configuration">
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={() => {
                              // If this token was created in this session and full token matches preview prefix
                              if (revealedToken && revealedToken.startsWith(t.tokenPreview.split('...')[0])) {
                                setActiveGuideToken(revealedToken);
                              } else {
                                setActiveGuideToken('');
                              }
                            }}
                          >
                            <SmartToyOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t.revoked ? 'Already revoked' : 'Revoke this token'}>
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              disabled={t.revoked}
                              onClick={() => setPendingRevoke(t)}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* MCP & AI Client Connection Guide Card */}
      <McpClientGuide initialToken={activeGuideToken || revealedToken || ''} />

      {/* One-time token reveal */}
      <Dialog open={!!revealedToken} onClose={() => { setRevealedToken(null); setCopied(false); }} maxWidth="sm" fullWidth>
        <DialogTitle>Token created</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Copy this token now — it won't be shown again.
          </DialogContentText>
          <Paper variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1, wordBreak: 'break-all' }}>
            <Typography variant="body2" component="code" sx={{ flexGrow: 1 }}>
              {revealedToken}
            </Typography>
            <IconButton onClick={copyRevealedToken} size="small">
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Paper>
          {copied && (
            <Typography variant="caption" color="success.main" sx={{ mt: 1, display: 'block' }}>
              Copied to clipboard.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setRevealedToken(null); setCopied(false); }}>Done</Button>
        </DialogActions>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog open={!!pendingRevoke} onClose={() => setPendingRevoke(null)}>
        <DialogTitle>Revoke token?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Revoking "{pendingRevoke?.name}" will immediately stop it from working. This can't be undone — you'd need to create a new token.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingRevoke(null)} disabled={revoking}>
            Cancel
          </Button>
          <Button
            onClick={handleRevoke}
            color="error"
            variant="contained"
            disabled={revoking}
            startIcon={revoking ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            Revoke
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
