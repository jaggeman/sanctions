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
import { apiFetch } from './apiFetch';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

type AccessState = 'checking' | 'admin' | 'denied';

interface ApiToken {
  id: string;
  name: string;
  tokenPreview: string;
  scopes: Array<'read' | 'write'>;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

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
  const [creating, setCreating] = useState(false);

  const [revealedToken, setRevealedToken] = useState<string | null>(null);
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

  const handleCreate = async () => {
    if (!name.trim()) return;
    const scopes = [scopeRead && 'read', scopeWrite && 'write'].filter(Boolean) as string[];
    if (scopes.length === 0) {
      setError('Select at least one scope (read or write).');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes }),
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
      setName('');
      setScopeRead(true);
      setScopeWrite(false);
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

          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              label="Token name"
              placeholder="e.g. CI pipeline"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={creating}
              sx={{ minWidth: 260 }}
            />
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
            <Button
              variant="contained"
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              startIcon={creating ? <CircularProgress size={18} color="inherit" /> : undefined}
            >
              Create Token
            </Button>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card sx={{ p: 2 }}>
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
                      <TableCell>
                        <Chip
                          label={t.revoked ? 'Revoked' : 'Active'}
                          size="small"
                          color={t.revoked ? 'default' : 'success'}
                        />
                      </TableCell>
                      <TableCell align="right">
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
