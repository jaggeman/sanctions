import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  CircularProgress,
  Alert,
  Tabs,
  Tab,
  IconButton,
  Tooltip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import UploadFileIcon from '@mui/icons-material/CloudUpload';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircle';
import DangerousOutlinedIcon from '@mui/icons-material/Warning';
import RefreshIcon from '@mui/icons-material/Refresh';
import { apiFetch } from './apiFetch';

interface MonitoredSubject {
  id: string;
  customerId: string;
  name: string;
  type?: 'individual' | 'entity';
  dob?: string;
  country?: string;
  nationality?: string;
  portfolio?: string;
  status: 'active' | 'paused' | 'archived';
  lastScreenedAt?: string;
  lastMatchScore?: number;
  createdAt: string;
}

interface MonitoringAlert {
  id: string;
  subjectId: string;
  customerId: string;
  subjectName: string;
  entityId: string;
  score: number;
  matchedAlias: string;
  source: string;
  status: 'new' | 'investigating' | 'dismissed_false_positive' | 'confirmed_true_positive';
  autoCleared: boolean;
  notes?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

interface MonitoringRunSummary {
  portfolioId?: string;
  totalScreened: number;
  matchesFound: number;
  newAlerts: number;
  autoCleared: number;
  durationMs: number;
  completedAt: string;
}

export default function MonitoringTab({ onSelectRecord }: { onSelectRecord: (recordId: string) => void }) {
  const [subTab, setSubTab] = useState<'alerts' | 'subjects'>('alerts');
  const [subjects, setSubjects] = useState<MonitoredSubject[]>([]);
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isScreening, setIsScreening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<MonitoringRunSummary | null>(null);

  // Add Subject Dialog state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'individual' | 'entity'>('individual');
  const [dob, setDob] = useState('');
  const [country, setCountry] = useState('');
  const [portfolio, setPortfolio] = useState('default');
  const [addError, setAddError] = useState<string | null>(null);

  // Resolve Alert Dialog state
  const [resolveTarget, setResolveTarget] = useState<MonitoringAlert | null>(null);
  const [resolveVerdict, setResolveVerdict] = useState<'false_positive' | 'true_positive'>('false_positive');
  const [resolveNotes, setResolveNotes] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  // Batch CSV Import state
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [isBatchSubmitting, setIsBatchSubmitting] = useState(false);

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [subjRes, alertsRes] = await Promise.all([
        apiFetch('/api/monitoring/subjects'),
        apiFetch('/api/monitoring/alerts'),
      ]);

      if (subjRes.ok) {
        const subjData = await subjRes.json();
        setSubjects(Array.isArray(subjData) ? subjData : []);
      }
      if (alertsRes.ok) {
        const alertsData = await alertsRes.json();
        setAlerts(Array.isArray(alertsData) ? alertsData : []);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load portfolio monitoring data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRunScreening = async () => {
    setIsScreening(true);
    setError(null);
    try {
      const res = await apiFetch('/api/monitoring/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('Screening failed');
      const data = await res.json();
      setRunSummary(data);
      await fetchData();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Screening execution failed.');
    } finally {
      setIsScreening(false);
    }
  };

  const handleAddSubject = async () => {
    if (!customerId.trim() || !name.trim()) {
      setAddError('Customer ID and Full Name are required.');
      return;
    }
    setAddError(null);
    try {
      const res = await apiFetch('/api/monitoring/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId.trim(),
          name: name.trim(),
          type,
          dob: dob.trim() || undefined,
          country: country.trim() || undefined,
          portfolio: portfolio.trim() || 'default',
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add customer');
      }
      setIsAddOpen(false);
      setCustomerId('');
      setName('');
      setDob('');
      setCountry('');
      await fetchData();
    } catch (err: any) {
      setAddError(err.message);
    }
  };

  const handleDeleteSubject = async (id: string) => {
    if (!window.confirm('Remove this customer from ongoing monitoring?')) return;
    try {
      const res = await apiFetch(`/api/monitoring/subjects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSubjects((prev) => prev.filter((s) => s.id !== id));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleResolveAlert = async () => {
    if (!resolveTarget) return;
    setIsResolving(true);
    try {
      const res = await apiFetch(`/api/monitoring/alerts/${encodeURIComponent(resolveTarget.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verdict: resolveVerdict,
          notes: resolveNotes.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to resolve alert');
      }
      setResolveTarget(null);
      setResolveNotes('');
      await fetchData();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsResolving(false);
    }
  };

  const handleBatchImport = async () => {
    if (!csvText.trim()) return;
    setIsBatchSubmitting(true);
    setBatchError(null);
    setBatchResult(null);
    try {
      const lines = csvText.trim().split(/\r?\n/);
      const parsedSubjects = lines
        .map((line) => {
          const parts = line.split(',').map((p) => p.trim());
          if (parts.length < 2) return null;
          return {
            customerId: parts[0],
            name: parts[1],
            dob: parts[2] || undefined,
            country: parts[3] || undefined,
            portfolio: parts[4] || 'default',
          };
        })
        .filter(Boolean);

      if (parsedSubjects.length === 0) {
        throw new Error('No valid customer lines found. Expected format: CustomerID, Name, DOB, Country, Portfolio');
      }

      const res = await apiFetch('/api/monitoring/subjects/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjects: parsedSubjects }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Batch import failed');
      }
      const data = await res.json();
      setBatchResult(`Successfully registered ${data.registeredCount} customers into monitoring.`);
      setCsvText('');
      await fetchData();
    } catch (err: any) {
      setBatchError(err.message);
    } finally {
      setIsBatchSubmitting(false);
    }
  };

  const openAlertsCount = alerts.filter((a) => a.status === 'new' || a.status === 'investigating').length;

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', p: { xs: 2, md: 3 } }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" gutterBottom sx={{ fontWeight: 600 }}>
            Ongoing Monitoring & Portfolios
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Continuous screening of customer portfolios against daily sanctions updates with automatic Decision Memory (#320) & Webhooks (#318).
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={fetchData}
            disabled={isLoading}
          >
            Refresh
          </Button>
          <Button
            variant="outlined"
            startIcon={<UploadFileIcon />}
            onClick={() => setIsBatchOpen(true)}
          >
            Import CSV
          </Button>
          <Button
            variant="outlined"
            startIcon={<PersonAddIcon />}
            onClick={() => setIsAddOpen(true)}
          >
            Add Customer
          </Button>
          <Button
            variant="contained"
            color="primary"
            startIcon={isScreening ? <CircularProgress size={20} color="inherit" /> : <PlayArrowIcon />}
            onClick={handleRunScreening}
            disabled={isScreening || subjects.length === 0}
          >
            Run Screening Now
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {runSummary && (
        <Alert severity="success" sx={{ mb: 3 }} onClose={() => setRunSummary(null)}>
          Screening run completed in {runSummary.durationMs}ms: {runSummary.totalScreened} customers checked,{' '}
          {runSummary.matchesFound} matches ({runSummary.newAlerts} new alerts, {runSummary.autoCleared} auto-cleared by Decision Memory).
        </Alert>
      )}

      {/* Overview Cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 2, mb: 3 }}>
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary" variant="body2">Monitored Customers</Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, mt: 1 }}>{subjects.length}</Typography>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary" variant="body2">Open Alerts for Review</Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, mt: 1, color: openAlertsCount > 0 ? 'error.main' : 'text.primary' }}>
              {openAlertsCount}
            </Typography>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary" variant="body2">Auto-cleared Hits</Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, mt: 1, color: 'success.main' }}>
              {alerts.filter((a) => a.status === 'dismissed_false_positive' || a.autoCleared).length}
            </Typography>
          </CardContent>
        </Card>
      </Box>

      {/* Tabs */}
      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={subTab}
          onChange={(_, v) => setSubTab(v)}
          indicatorColor="primary"
          textColor="primary"
        >
          <Tab
            label={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <span>Alerts & Cases</span>
                {openAlertsCount > 0 && (
                  <Chip label={openAlertsCount} size="small" color="error" sx={{ height: 20, fontSize: '0.75rem' }} />
                )}
              </Box>
            }
            value="alerts"
          />
          <Tab label={`Monitored Customers (${subjects.length})`} value="subjects" />
        </Tabs>
      </Paper>

      {/* Sub-tab 1: Alerts Queue */}
      {subTab === 'alerts' && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Score</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Customer ID / Name</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Matched Sanction Entity</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Source</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Created</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {alerts.map((alert) => (
                <TableRow key={alert.id} hover>
                  <TableCell>
                    <Chip
                      label={`${alert.score}%`}
                      size="small"
                      color={alert.score >= 90 ? 'error' : alert.score >= 75 ? 'warning' : 'default'}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{alert.customerId}</Typography>
                    <Typography variant="caption" color="text.secondary">{alert.subjectName}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="body2"
                      sx={{ color: 'primary.main', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => onSelectRecord(alert.entityId)}
                    >
                      {alert.matchedAlias || alert.entityId}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={alert.source} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    {alert.status === 'new' && <Chip label="New Alert" size="small" color="error" />}
                    {alert.status === 'investigating' && <Chip label="Investigating" size="small" color="warning" />}
                    {alert.status === 'dismissed_false_positive' && (
                      <Chip label="False Positive" size="small" color="success" variant="outlined" />
                    )}
                    {alert.status === 'confirmed_true_positive' && (
                      <Chip label="Confirmed Risk" size="small" color="error" variant="outlined" />
                    )}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.8rem', color: 'text.secondary' }}>
                    {new Date(alert.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell align="right">
                    {alert.status === 'new' || alert.status === 'investigating' ? (
                      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                        <Button
                          size="small"
                          color="success"
                          variant="outlined"
                          startIcon={<CheckCircleOutlineIcon />}
                          onClick={() => {
                            setResolveTarget(alert);
                            setResolveVerdict('false_positive');
                          }}
                        >
                          Clear (FP)
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          variant="outlined"
                          startIcon={<DangerousOutlinedIcon />}
                          onClick={() => {
                            setResolveTarget(alert);
                            setResolveVerdict('true_positive');
                          }}
                        >
                          Confirm
                        </Button>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        Resolved by {alert.resolvedBy || 'analyst'}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {alerts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No monitoring alerts found. Run a screening to check portfolios against latest sanctions.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Sub-tab 2: Monitored Subjects */}
      {subTab === 'subjects' && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Customer ID</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Type</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Portfolio</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>DOB / Country</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Last Match Score</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Last Screened</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {subjects.map((s) => (
                <TableRow key={s.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{s.customerId}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    <Chip label={s.type || 'individual'} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip label={s.portfolio || 'default'} size="small" color="primary" variant="outlined" />
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>
                    {[s.dob, s.country].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                  <TableCell>
                    {typeof s.lastMatchScore === 'number' && s.lastMatchScore > 0 ? (
                      <Chip
                        label={`${s.lastMatchScore}%`}
                        size="small"
                        color={s.lastMatchScore >= 90 ? 'error' : s.lastMatchScore >= 75 ? 'warning' : 'default'}
                      />
                    ) : (
                      <Typography variant="caption" color="text.secondary">0%</Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>
                    {s.lastScreenedAt ? new Date(s.lastScreenedAt).toLocaleString() : 'Never'}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Remove customer">
                      <IconButton size="small" color="error" onClick={() => handleDeleteSubject(s.id)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {subjects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No customers registered for continuous monitoring. Click "Add Customer" or "Import CSV" to begin.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add Customer Modal */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Customer to Ongoing Monitoring</DialogTitle>
        <DialogContent dividers>
          {addError && <Alert severity="error" sx={{ mb: 2 }}>{addError}</Alert>}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              label="Customer ID / External Reference *"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="e.g. CUST-9821"
              fullWidth
            />
            <TextField
              label="Customer / Entity Full Name *"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alexander Smirnov"
              fullWidth
            />
            <TextField
              select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as any)}
              fullWidth
            >
              <MenuItem value="individual">Individual</MenuItem>
              <MenuItem value="entity">Corporate Entity</MenuItem>
            </TextField>
            <TextField
              label="Date of Birth (optional)"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              placeholder="YYYY-MM-DD"
              fullWidth
            />
            <TextField
              label="Country / Nationality (optional)"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="e.g. SE, RU, US"
              fullWidth
            />
            <TextField
              label="Portfolio / Group"
              value={portfolio}
              onChange={(e) => setPortfolio(e.target.value)}
              placeholder="e.g. wealth-management, retail"
              fullWidth
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleAddSubject}>Save Customer</Button>
        </DialogActions>
      </Dialog>

      {/* Resolve Alert Modal */}
      <Dialog open={Boolean(resolveTarget)} onClose={() => setResolveTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Adjudicate Match: {resolveTarget?.customerId} ({resolveTarget?.subjectName})
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Recording this adjudication will resolve the alert and persist the decision in{' '}
            <strong>Decision Memory (#320)</strong> so future re-screenings of this customer will be auto-cleared.
          </Typography>
          <TextField
            select
            label="Verdict *"
            value={resolveVerdict}
            onChange={(e) => setResolveVerdict(e.target.value as any)}
            fullWidth
            sx={{ mb: 2 }}
          >
            <MenuItem value="false_positive">False Positive (Clear Match)</MenuItem>
            <MenuItem value="true_positive">True Positive (Confirmed Match / Sanctioned)</MenuItem>
          </TextField>
          <TextField
            label="Analyst Notes / Justification"
            value={resolveNotes}
            onChange={(e) => setResolveNotes(e.target.value)}
            placeholder="e.g. Verified date of birth and passport copy differ from sanctions list record."
            multiline
            rows={3}
            fullWidth
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveTarget(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={resolveVerdict === 'false_positive' ? 'success' : 'error'}
            onClick={handleResolveAlert}
            disabled={isResolving}
          >
            {isResolving ? <CircularProgress size={20} color="inherit" /> : 'Save Decision'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Batch CSV Import Modal */}
      <Dialog open={isBatchOpen} onClose={() => setIsBatchOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Batch Import Customer Portfolio (CSV)</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            Paste CSV lines below. Format per line: <code>CustomerID, Name, DOB, Country, Portfolio</code>
          </Typography>
          {batchError && <Alert severity="error" sx={{ mb: 2 }}>{batchError}</Alert>}
          {batchResult && <Alert severity="success" sx={{ mb: 2 }}>{batchResult}</Alert>}
          <TextField
            multiline
            rows={8}
            fullWidth
            placeholder={"CUST-001, Alexander Smirnov, 1985-04-12, SE, retail\nCUST-002, ACME Corp,, US, corporate"}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsBatchOpen(false)}>Close</Button>
          <Button
            variant="contained"
            onClick={handleBatchImport}
            disabled={isBatchSubmitting || !csvText.trim()}
          >
            {isBatchSubmitting ? <CircularProgress size={20} color="inherit" /> : 'Import Portfolio'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
