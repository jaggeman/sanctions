import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Grid,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Button,
  CircularProgress,
  Alert,
  Tooltip,
  Divider,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import StorageIcon from '@mui/icons-material/Storage';
import CloudQueueIcon from '@mui/icons-material/CloudQueue';
import HistoryEduIcon from '@mui/icons-material/HistoryEdu';
import BugReportIcon from '@mui/icons-material/BugReport';
import { apiFetch } from './apiFetch';

interface SystemStatusResponse {
  status: string;
  serverTime: string;
  uptimeSeconds: number;
  environment: string;
  database: {
    connected: boolean;
    projectId: string;
    latencyMs: number;
    counts: Record<string, number>;
  };
  functions: Array<{
    name: string;
    type: string;
    region: string;
    status: string;
    url?: string;
    schedule?: string;
    queue?: string;
  }>;
  releases: Array<{
    version: string;
    timestamp: string;
    deployedBy: string;
    commitSha: string;
    environment: string;
    summary: string;
  }>;
}

interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: 'error' | 'warn' | 'info';
  module: string;
  message: string;
  details?: Record<string, unknown>;
}

export default function DriftStatusTab() {
  const [statusData, setStatusData] = useState<SystemStatusResponse | null>(null);
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'ALL' | 'error' | 'warn' | 'info'>('ALL');

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [statusRes, logsRes] = await Promise.all([
        apiFetch('/api/system/status'),
        apiFetch('/api/system/logs'),
      ]);

      if (!statusRes.ok) {
        throw new Error(`Could not load system status (${statusRes.status})`);
      }
      if (!logsRes.ok) {
        throw new Error(`Could not load system logs (${logsRes.status})`);
      }

      const statusJson: SystemStatusResponse = await statusRes.json();
      const logsJson = await logsRes.json();

      setStatusData(statusJson);
      setLogs(logsJson.logs || []);
    } catch (err: any) {
      setError(err.message || 'An error occurred while loading system status.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Auto-refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleManualRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  };

  // Keep the table short (repo owner request): show only the 5 most recent
  // entries for whichever filter is active, newest first, rather than every
  // buffered log unbounded.
  const LOG_DISPLAY_LIMIT = 5;
  const filteredLogs = (logFilter === 'ALL' ? logs : logs.filter((l) => l.level === logFilter))
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, LOG_DISPLAY_LIMIT);

  if (loading && !statusData) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Top Header & Actions */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <StorageIcon color="primary" /> System Status & Health
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Real-time monitoring of Firebase Firestore, Cloud Functions, error logs, and deployment history.
          </Typography>
        </Box>
        <Tooltip title="Refresh system status">
          <span>
            <Button
              variant="outlined"
              startIcon={refreshing ? <CircularProgress size={18} /> : <RefreshIcon />}
              onClick={handleManualRefresh}
              disabled={refreshing}
            >
              Refresh
            </Button>
          </span>
        </Tooltip>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* SECTION 1: System Health Overview */}
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <CloudQueueIcon color="primary" fontSize="small" /> System Health
        </Typography>

        <Grid container spacing={2.5}>
          {/* Main Status Card */}
          <Grid size={{ xs: 12, md: 4 }}>
            <Card variant="outlined" sx={{ height: '100%', borderRadius: 2 }}>
              <CardContent sx={{ p: 2.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Total System Status
                  </Typography>
                  <Chip
                    icon={statusData?.status === 'healthy' ? <CheckCircleIcon /> : <WarningIcon />}
                    label={statusData?.status === 'healthy' ? 'OPERATIONAL' : 'DEGRADED'}
                    color={statusData?.status === 'healthy' ? 'success' : 'warning'}
                    size="small"
                    sx={{ fontWeight: 700 }}
                  />
                </Box>
                <Typography variant="h4" sx={{ fontWeight: 700, my: 1 }}>
                  {statusData?.status === 'healthy' ? '100% Operational' : 'Warnings'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Environment: <strong>{statusData?.environment}</strong> ({statusData?.database?.projectId})
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Uptime: <strong>{statusData ? formatUptime(statusData.uptimeSeconds) : '-'}</strong>
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          {/* Database Health Card */}
          <Grid size={{ xs: 12, md: 4 }}>
            <Card variant="outlined" sx={{ height: '100%', borderRadius: 2 }}>
              <CardContent sx={{ p: 2.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Firestore Database
                  </Typography>
                  <Chip
                    label={statusData?.database?.connected ? 'CONNECTED' : 'DISCONNECTED'}
                    color={statusData?.database?.connected ? 'success' : 'error'}
                    size="small"
                    sx={{ fontWeight: 700 }}
                  />
                </Box>
                <Typography variant="h4" sx={{ fontWeight: 700, my: 1 }}>
                  {(statusData?.database?.counts?.total ?? 0).toLocaleString()} <span style={{ fontSize: '1rem', fontWeight: 500 }}>records</span>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Latency: <strong>{statusData?.database?.latencyMs} ms</strong>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Project: <strong>{statusData?.database?.projectId}</strong>
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          {/* Cloud Functions Breakdown */}
          <Grid size={{ xs: 12, md: 4 }}>
            <Card variant="outlined" sx={{ height: '100%', borderRadius: 2 }}>
              <CardContent sx={{ p: 2.5 }}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Active Cloud Functions
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {statusData?.functions?.map((fn) => (
                    <Box
                      key={fn.name}
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        p: 0.75,
                        borderRadius: 1,
                        bgcolor: 'action.hover',
                      }}
                    >
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {fn.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {fn.type} ({fn.region})
                        </Typography>
                      </Box>
                      <Chip label={fn.status} color="success" size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
                    </Box>
                  ))}
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Box>

      {/* Database Breakdown per Source */}
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
          Sanctions records per source in database
        </Typography>
        <Grid container spacing={2}>
          {Object.entries(statusData?.database?.counts || {})
            .filter(([source]) => source !== 'total')
            .map(([source, count]) => (
              <Grid size={{ xs: 6, sm: 4, md: 2 }} key={source}>
                <Paper variant="outlined" sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                    {source}
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 700, mt: 0.5 }}>
                    {count.toLocaleString()}
                  </Typography>
                </Paper>
              </Grid>
            ))}
        </Grid>
      </Box>

      <Divider />

      {/* SECTION 2: Error Logs on Functions */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
              <BugReportIcon color="error" fontSize="small" /> Error Logs & System Events
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Showing the {LOG_DISPLAY_LIMIT} most recent entries
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            {(['ALL', 'error', 'warn', 'info'] as const).map((filter) => (
              <Button
                key={filter}
                size="small"
                variant={logFilter === filter ? 'contained' : 'outlined'}
                onClick={() => setLogFilter(filter)}
                sx={{ textTransform: 'uppercase', fontSize: '0.75rem', px: 1.5 }}
              >
                {filter === 'ALL' ? 'All' : filter}
              </Button>
            ))}
          </Box>
        </Box>

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
          <Table size="small">
            <TableHead sx={{ bgcolor: 'action.hover' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, width: '180px' }}>Timestamp</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '100px' }}>Level</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '180px' }}>Module / Function</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Event / Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredLogs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    No logs match the selected filter.
                  </TableCell>
                </TableRow>
              ) : (
                filteredLogs.map((log) => (
                  <TableRow key={log.id} hover>
                    <TableCell sx={{ fontSize: '0.8rem', color: 'text.secondary', fontFamily: 'monospace' }}>
                      {new Date(log.timestamp).toLocaleString('en-US')}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={log.level.toUpperCase()}
                        size="small"
                        color={log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'info'}
                        sx={{ fontSize: '0.7rem', fontWeight: 700, height: '20px' }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.85rem', fontFamily: 'monospace', fontWeight: 600 }}>
                      {log.module}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.85rem' }}>{log.message}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>

      <Divider />

      {/* SECTION 3: Recent 3 Releases */}
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <HistoryEduIcon color="primary" fontSize="small" /> Recent Releases & Deployment History
        </Typography>

        <Grid container spacing={2.5}>
          {statusData?.releases?.slice(0, 3).map((release, idx) => (
            <Grid size={{ xs: 12, md: 4 }} key={release.version}>
              <Card variant="outlined" sx={{ height: '100%', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
                {idx === 0 && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 4,
                      bgcolor: 'primary.main',
                    }}
                  />
                )}
                <CardContent sx={{ p: 2.5 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                      {release.version}
                    </Typography>
                    <Chip
                      label={idx === 0 ? 'LIVE / CURRENT' : 'ARCHIVED'}
                      color={idx === 0 ? 'success' : 'default'}
                      size="small"
                      sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                    />
                  </Box>

                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                    📅 {new Date(release.timestamp).toLocaleString('en-US')} ({release.environment})
                  </Typography>

                  <Typography variant="body2" sx={{ mb: 1.5, color: 'text.secondary' }}>
                    Deployed by: <strong>{release.deployedBy}</strong>
                  </Typography>

                  <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1.5, mb: 1.5 }}>
                    <Typography variant="body2" sx={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                      {release.summary}
                    </Typography>
                  </Paper>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      Commit SHA:
                    </Typography>
                    <Chip
                      label={release.commitSha}
                      size="small"
                      variant="outlined"
                      sx={{ fontFamily: 'monospace', fontSize: '0.75rem', height: '22px' }}
                    />
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
    </Box>
  );
}
