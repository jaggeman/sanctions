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
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AddLinkIcon from '@mui/icons-material/AddLink';
import { apiFetch } from './apiFetch';

interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  events: string[];
  description?: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const AVAILABLE_EVENTS = [
  { id: 'decision.recorded', label: 'Case Decision (True/False Positive)', desc: 'Fires when an analyst records or overwrites a screening adjudication' },
  { id: 'alert.created', label: 'Match Alert Detected', desc: 'Fires when screening detects a candidate above threshold' },
  { id: 'import.completed', label: 'Official List Import Completed', desc: 'Fires when nightly ingestion finishes updating sanction registers' },
];

export default function WebhooksTab() {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New webhook modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([
    'decision.recorded',
    'alert.created',
    'import.completed',
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Created secret display modal
  const [createdWebhook, setCreatedWebhook] = useState<WebhookSubscription | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Test ping state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<WebhookSubscription | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/webhooks');
      if (!res.ok) {
        throw new Error('Failed to load webhook subscriptions');
      }
      const data = await res.json();
      setSubscriptions(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Could not load webhooks.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  const handleCreate = async () => {
    if (!newUrl.trim()) {
      setCreateError('Endpoint URL is required.');
      return;
    }
    setIsSubmitting(true);
    setCreateError(null);
    try {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl.trim(),
          description: newDescription.trim() || undefined,
          events: selectedEvents,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to create webhook subscription.');
      }

      const created = await res.json();
      setCreatedWebhook(created);
      setIsCreateOpen(false);
      setNewUrl('');
      setNewDescription('');
      fetchSubscriptions();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create webhook.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTestPing = async (sub: WebhookSubscription) => {
    setTestingId(sub.id);
    setTestResult(null);
    try {
      const res = await apiFetch(`/api/webhooks/${sub.id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setTestResult({
          id: sub.id,
          success: true,
          message: `Ping delivered successfully (HTTP ${data.statusCode}, ${data.durationMs}ms)`,
        });
      } else {
        setTestResult({
          id: sub.id,
          success: false,
          message: `Delivery failed: ${data.error || `HTTP ${data.statusCode}`}`,
        });
      }
    } catch (err: any) {
      setTestResult({
        id: sub.id,
        success: false,
        message: `Error sending test ping: ${err.message}`,
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await apiFetch(`/api/webhooks/${deleteTarget.id}`, { method: 'DELETE' });
      if (res.ok) {
        setSubscriptions((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <Box>
      <Card sx={{ mb: 4, p: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 2 }}>
            <Box>
              <Typography variant="h5" gutterBottom>
                Webhook Subscriptions
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Receive real-time signed HTTP POST notifications in your backend or CRM when screening alerts occur or decisions are adjudicated.
              </Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<AddLinkIcon />}
              onClick={() => setIsCreateOpen(true)}
            >
              Add Endpoint
            </Button>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {testResult && (
            <Alert
              severity={testResult.success ? 'success' : 'warning'}
              sx={{ mb: 2 }}
              onClose={() => setTestResult(null)}
            >
              {testResult.message}
            </Alert>
          )}

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : subscriptions.length === 0 ? (
            <Paper sx={{ p: 4, textAlign: 'center', opacity: 0.8 }}>
              <Typography variant="body1">No webhook endpoints registered yet.</Typography>
              <Typography variant="caption" color="text.secondary">
                Click "Add Endpoint" to configure your first destination URL and obtain an HMAC-SHA256 signing secret.
              </Typography>
            </Paper>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Endpoint URL & Description</TableCell>
                  <TableCell>Subscribed Events</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <Typography variant="subtitle2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                        {sub.url}
                      </Typography>
                      {sub.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {sub.description}
                        </Typography>
                      )}
                      <Typography variant="caption" sx={{ opacity: 0.6, display: 'block' }}>
                        ID: {sub.id}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {sub.events.map((ev) => (
                          <Chip key={ev} label={ev} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
                        ))}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={sub.active ? 'Active' : 'Disabled'}
                        size="small"
                        color={sub.active ? 'success' : 'default'}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {new Date(sub.createdAt).toLocaleDateString()}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Send test ping to endpoint">
                        <span>
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={() => handleTestPing(sub)}
                            disabled={testingId === sub.id}
                          >
                            {testingId === sub.id ? <CircularProgress size={18} /> : <PlayArrowIcon />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Delete endpoint">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => setDeleteTarget(sub)}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Register Endpoint Dialog */}
      <Dialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Register Webhook Endpoint</DialogTitle>
        <DialogContent>
          {createError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {createError}
            </Alert>
          )}
          <TextField
            fullWidth
            label="Destination URL"
            placeholder="https://api.yourcompany.com/webhooks/sanctions"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            fullWidth
            label="Description (optional)"
            placeholder="e.g. Core Banking AML Gateway"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            sx={{ mb: 2 }}
          />
          <Typography variant="subtitle2" gutterBottom>
            Events to dispatch:
          </Typography>
          <FormGroup>
            {AVAILABLE_EVENTS.map((ev) => (
              <FormControlLabel
                key={ev.id}
                control={
                  <Checkbox
                    checked={selectedEvents.includes(ev.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedEvents((prev) => [...prev, ev.id]);
                      } else {
                        setSelectedEvents((prev) => prev.filter((id) => id !== ev.id));
                      }
                    }}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{ev.label}</Typography>
                    <Typography variant="caption" color="text.secondary">{ev.desc}</Typography>
                  </Box>
                }
                sx={{ mb: 1, alignItems: 'flex-start' }}
              />
            ))}
          </FormGroup>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsCreateOpen(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleCreate} variant="contained" disabled={isSubmitting}>
            {isSubmitting ? <CircularProgress size={20} /> : 'Save Endpoint'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Secret Created Dialog */}
      <Dialog open={Boolean(createdWebhook)} onClose={() => setCreatedWebhook(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Webhook Endpoint Created</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Save your signing secret now. Use it to verify the <code>X-Sanctions-Signature</code> header on incoming requests.
          </Alert>
          <Typography variant="subtitle2" gutterBottom>
            Signing Secret:
          </Typography>
          <Paper
            sx={{
              p: 1.5,
              bgcolor: 'action.hover',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              wordBreak: 'break-all',
            }}
          >
            <span>{createdWebhook?.secret}</span>
            <IconButton
              size="small"
              onClick={() => {
                if (createdWebhook?.secret) {
                  navigator.clipboard.writeText(createdWebhook.secret);
                  setCopiedSecret(true);
                  setTimeout(() => setCopiedSecret(false), 2000);
                }
              }}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Paper>
          {copiedSecret && (
            <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 0.5 }}>
              Copied secret to clipboard!
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreatedWebhook(null)} variant="contained">
            Done
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete Webhook Endpoint?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete the endpoint <strong>{deleteTarget?.url}</strong>? Outgoing events will no longer be dispatched to this address.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
