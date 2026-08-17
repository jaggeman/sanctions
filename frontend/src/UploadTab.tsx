import { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Paper,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
  Chip,
  Checkbox,
  FormControlLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Divider,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SyncIcon from '@mui/icons-material/Sync';
import { apiFetch } from './apiFetch';

type SanctionSourceOption = 'AUTO' | 'EU' | 'UN' | 'US' | 'UK' | 'PEP' | 'CUSTOM';
type ImportMode = 'sync' | 'append';

interface SampleRecord {
  id: string;
  primaryName: string;
}

interface DiffSamples {
  added: SampleRecord[];
  updated: SampleRecord[];
  unchanged: SampleRecord[];
  delisted: SampleRecord[];
}

interface DiffResultData {
  source: string;
  counts: { parsed: number; added: number; updated: number; unchanged: number; delisted: number; skipped: number };
  samples: DiffSamples;
  toDelistIds: string[];
  activeCount: number;
  guardTripped: boolean;
}

interface PreviewState {
  counts: { parsed: number; uploaded: number };
  diffs: DiffResultData[];
}

interface BatchItem {
  id: string;
  filename: string;
  size: number;
  file: File;
  status: 'pending' | 'previewed' | 'uploading' | 'applied' | 'skipped' | 'failed';
  message?: string;
  duplicateImportId?: string;
  counts?: { parsed?: number; uploaded?: number };
  diffs?: DiffResultData[];
  guardTripped?: boolean;
}

function formatDiffSummary(diffs?: DiffResultData[], counts?: { parsed?: number; uploaded?: number }): string {
  if (!diffs || diffs.length === 0) {
    return counts?.parsed !== undefined ? `Parsed: ${counts.parsed}` : 'Ready';
  }
  const parts: string[] = [];
  const added = diffs.reduce((s, d) => s + d.counts.added, 0);
  const updated = diffs.reduce((s, d) => s + d.counts.updated, 0);
  const unchanged = diffs.reduce((s, d) => s + d.counts.unchanged, 0);
  const delisted = diffs.reduce((s, d) => s + d.counts.delisted, 0);

  if (added > 0) parts.push(`+${added} added`);
  if (updated > 0) parts.push(`~${updated} updated`);
  if (unchanged > 0) parts.push(`=${unchanged} unchanged`);
  if (delisted > 0) parts.push(`-${delisted} delisted`);

  return parts.length > 0 ? parts.join(', ') : `Parsed: ${counts?.parsed ?? 0}`;
}

interface UploadTabProps {
  onViewImport: (importId: string) => void;
}

const SOURCES: { value: SanctionSourceOption; label: string }[] = [
  { value: 'AUTO', label: 'Auto-detect Source' },
  { value: 'EU', label: 'EU' },
  { value: 'UN', label: 'UN' },
  { value: 'US', label: 'US (OFAC SDN)' },
  { value: 'UK', label: 'UK Sanctions' },
  { value: 'PEP', label: 'PEP' },
  { value: 'CUSTOM', label: 'Custom' },
];

function SampleChips({ samples }: { samples: SampleRecord[] }) {
  if (samples.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
      {samples.map((s) => (
        <Chip key={s.id} label={s.primaryName} size="small" variant="outlined" />
      ))}
    </Box>
  );
}

function DiffBucket({ label, count, samples }: { label: string; count: number; samples: SampleRecord[] }) {
  if (count === 0) return null;
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="body2">
        <strong>{label}:</strong> {count}
      </Typography>
      <SampleChips samples={samples} />
    </Box>
  );
}

export default function UploadTab({ onViewImport }: UploadTabProps) {
  const [source, setSource] = useState<SanctionSourceOption>('AUTO');
  const [mode, setMode] = useState<ImportMode>('append');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [syncingOfficial, setSyncingOfficial] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [feedback, setFeedback] = useState<{
    severity: 'success' | 'error' | 'warning' | 'info';
    message: string;
    duplicateImportId?: string;
  } | null>(null);

  const singleGuardTripped = preview?.diffs.some((d) => d.guardTripped) ?? false;
  const batchGuardTripped = batchQueue.some((item) => item.guardTripped) ?? false;
  const guardTripped = singleGuardTripped || batchGuardTripped;
  const totalDelisted = preview?.diffs.reduce((sum, d) => sum + d.counts.delisted, 0) ?? 0;
  const isBusy = previewing || applying || syncingOfficial;

  function resetForNextUpload() {
    setSelectedFile(null);
    setPreview(null);
    setOverrideConfirmed(false);
  }

  async function runUpload(
    file: File,
    dryRun: boolean,
    force: boolean,
    sourceOverride?: SanctionSourceOption,
    modeOverride?: ImportMode,
  ) {
    const effectiveSource = sourceOverride ?? source;
    const effectiveMode = modeOverride ?? mode;
    const formData = new FormData();
    formData.append('file', file);
    if (effectiveSource !== 'AUTO') {
      formData.append('source', effectiveSource);
    }
    formData.append('mode', effectiveMode);
    formData.append('dryRun', dryRun ? 'true' : 'false');
    if (force) formData.append('force', 'true');

    const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  // A preview is only valid for the exact source/mode that produced it. If the
  // user changes either afterwards, the stale preview must never drive Apply
  // (issue #163) — re-run the dry run against the new settings instead of
  // forcing the user to re-select the file.
  async function rerunPreviewFor(nextSource: SanctionSourceOption, nextMode: ImportMode) {
    if (!selectedFile || previewing) return;
    setPreview(null);
    setOverrideConfirmed(false);
    setFeedback(null);
    setPreviewing(true);

    try {
      const { res, data } = await runUpload(selectedFile, true, false, nextSource, nextMode);

      if (res.status === 200 && data.status === 'dry_run') {
        setPreview({ counts: data.counts || { parsed: 0, uploaded: 0 }, diffs: data.diffs || [] });
      } else if (res.status === 409 && data.duplicateOfImportId) {
        setFeedback({
          severity: 'warning',
          message: data.error || `Identical file already imported as import #${data.duplicateOfImportId}.`,
          duplicateImportId: data.duplicateOfImportId,
        });
        setSelectedFile(null);
      } else if (res.status === 422) {
        setFeedback({ severity: 'error', message: data.error || 'This file format is not yet supported.' });
        setSelectedFile(null);
      } else {
        setFeedback({ severity: 'error', message: data.error || 'Preview failed.' });
        setSelectedFile(null);
      }
    } catch (err) {
      console.error(err);
      setFeedback({ severity: 'error', message: 'Preview failed. Please try again.' });
      setSelectedFile(null);
    }
    setPreviewing(false);
  }

  async function rerunBatchPreviewFor(nextSource: SanctionSourceOption, nextMode: ImportMode) {
    if (batchQueue.length === 0 || previewing) return;
    setPreviewing(true);
    setOverrideConfirmed(false);
    setFeedback(null);

    const updatedQueue: BatchItem[] = [];
    for (const item of batchQueue) {
      try {
        const { res, data } = await runUpload(item.file, true, false, nextSource, nextMode);
        if (res.status === 200 && data.status === 'dry_run') {
          const itemGuardTripped = data.diffs?.some((d: DiffResultData) => d.guardTripped) ?? false;
          updatedQueue.push({
            ...item,
            status: 'previewed',
            counts: data.counts,
            diffs: data.diffs,
            guardTripped: itemGuardTripped,
            message: formatDiffSummary(data.diffs, data.counts),
          });
        } else if (res.status === 409 && data.duplicateOfImportId) {
          updatedQueue.push({
            ...item,
            status: 'skipped',
            duplicateImportId: data.duplicateOfImportId,
            message: data.error || `Skipped: duplicate of import #${data.duplicateOfImportId}`,
          });
        } else {
          updatedQueue.push({
            ...item,
            status: 'failed',
            message: data.error || 'Preview failed',
          });
        }
      } catch (err: any) {
        updatedQueue.push({
          ...item,
          status: 'failed',
          message: err.message || 'Preview failed',
        });
      }
    }
    setBatchQueue(updatedQueue);
    setPreviewing(false);
  }

  function handleSourceChange(next: SanctionSourceOption) {
    setSource(next);
    if (preview) rerunPreviewFor(next, mode);
    if (batchQueue.length > 0 && batchQueue.some((i) => i.status === 'previewed')) {
      rerunBatchPreviewFor(next, mode);
    }
  }

  function handleModeChange(next: ImportMode) {
    setMode(next);
    if (preview) rerunPreviewFor(source, next);
    if (batchQueue.length > 0 && batchQueue.some((i) => i.status === 'previewed')) {
      rerunBatchPreviewFor(source, next);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = ''; // allow re-selecting the same file later

    if (files.length === 1) {
      // Single file interactive dry-run preview flow
      setBatchQueue([]);
      const file = files[0];
      setSelectedFile(file);
      setPreview(null);
      setOverrideConfirmed(false);
      setFeedback(null);
      setPreviewing(true);

      try {
        const { res, data } = await runUpload(file, true, false);

        if (res.status === 200 && data.status === 'dry_run') {
          setPreview({ counts: data.counts || { parsed: 0, uploaded: 0 }, diffs: data.diffs || [] });
        } else if (res.status === 409 && data.duplicateOfImportId) {
          setFeedback({
            severity: 'warning',
            message: data.error || `Identical file already imported as import #${data.duplicateOfImportId}.`,
            duplicateImportId: data.duplicateOfImportId,
          });
          setSelectedFile(null);
        } else if (res.status === 422) {
          setFeedback({ severity: 'error', message: data.error || 'This file format is not yet supported.' });
          setSelectedFile(null);
        } else {
          setFeedback({ severity: 'error', message: data.error || 'Preview failed.' });
          setSelectedFile(null);
        }
      } catch (err) {
        console.error(err);
        setFeedback({ severity: 'error', message: 'Preview failed. Please try again.' });
        setSelectedFile(null);
      }
      setPreviewing(false);
    } else {
      // Multi-file batch dry-run preview flow (issue #289)
      setSelectedFile(null);
      setPreview(null);
      setFeedback(null);
      setOverrideConfirmed(false);

      const items: BatchItem[] = files.map((f, idx) => ({
        id: `${f.name}-${idx}`,
        filename: f.name,
        size: f.size,
        file: f,
        status: 'pending',
      }));
      setBatchQueue(items);
      setPreviewing(true);

      const previewedItems = [...items];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const { res, data } = await runUpload(file, true, false);
          if (res.status === 200 && data.status === 'dry_run') {
            const itemGuardTripped = data.diffs?.some((d: DiffResultData) => d.guardTripped) ?? false;
            previewedItems[i] = {
              ...previewedItems[i],
              status: 'previewed',
              counts: data.counts,
              diffs: data.diffs,
              guardTripped: itemGuardTripped,
              message: formatDiffSummary(data.diffs, data.counts),
            };
          } else if (res.status === 409 && data.duplicateOfImportId) {
            previewedItems[i] = {
              ...previewedItems[i],
              status: 'skipped',
              duplicateImportId: data.duplicateOfImportId,
              message: `Skipped: duplicate of import #${data.duplicateOfImportId}`,
            };
          } else if (res.status === 422) {
            previewedItems[i] = {
              ...previewedItems[i],
              status: 'failed',
              message: data.error || 'This file format is not yet supported.',
            };
          } else {
            previewedItems[i] = {
              ...previewedItems[i],
              status: 'failed',
              message: data.error || 'Preview failed',
            };
          }
        } catch (err: any) {
          previewedItems[i] = {
            ...previewedItems[i],
            status: 'failed',
            message: err.message || 'Preview failed',
          };
        }
        setBatchQueue([...previewedItems]);
      }

      setPreviewing(false);
    }
  }

  async function handleApplyBatch() {
    setApplying(true);
    setFeedback(null);

    let successCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < batchQueue.length; i++) {
      const item = batchQueue[i];
      if (item.status !== 'previewed') {
        if (item.status === 'skipped') skippedCount++;
        continue;
      }

      setBatchQueue((prev) =>
        prev.map((it, idx) => (idx === i ? { ...it, status: 'uploading' } : it)),
      );

      try {
        const force = item.guardTripped ? overrideConfirmed : false;
        const { res, data } = await runUpload(item.file, false, force);
        if (res.status === 200 && data.status === 'applied') {
          successCount++;
          setBatchQueue((prev) =>
            prev.map((it, idx) =>
              idx === i
                ? {
                    ...it,
                    status: 'applied',
                    counts: data.counts,
                    message: `Applied: ${data.counts?.parsed ?? 0} parsed, ${data.counts?.uploaded ?? 0} saved`,
                  }
                : it,
            ),
          );
        } else if (res.status === 409 && data.duplicateOfImportId) {
          skippedCount++;
          setBatchQueue((prev) =>
            prev.map((it, idx) =>
              idx === i
                ? {
                    ...it,
                    status: 'skipped',
                    duplicateImportId: data.duplicateOfImportId,
                    message: `Skipped: duplicate of import #${data.duplicateOfImportId}`,
                  }
                : it,
            ),
          );
        } else {
          setBatchQueue((prev) =>
            prev.map((it, idx) =>
              idx === i ? { ...it, status: 'failed', message: data.error || 'Upload failed' } : it,
            ),
          );
        }
      } catch (err: any) {
        setBatchQueue((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: 'failed', message: err.message || 'Error' } : it,
          ),
        );
      }
    }

    setApplying(false);
    setFeedback({
      severity: 'success',
      message: `Batch complete: ${successCount} files imported, ${skippedCount} skipped as duplicates.`,
    });
  }

  async function handleApply() {
    if (!selectedFile) return;
    setApplying(true);
    setFeedback(null);

    try {
      const { res, data } = await runUpload(selectedFile, false, guardTripped && overrideConfirmed);

      if (res.status === 200 && data.status === 'applied') {
        const counts = data.counts || {};
        setFeedback({
          severity: 'success',
          message: `Import applied — parsed ${counts.parsed ?? 0}, uploaded ${counts.uploaded ?? 0}.`,
        });
        resetForNextUpload();
      } else if (res.status === 409 && data.duplicateOfImportId) {
        setFeedback({
          severity: 'warning',
          message: data.error || `Identical file already imported as import #${data.duplicateOfImportId}.`,
          duplicateImportId: data.duplicateOfImportId,
        });
        resetForNextUpload();
      } else {
        setFeedback({ severity: 'error', message: data.error || 'Apply failed.' });
      }
    } catch (err) {
      console.error(err);
      setFeedback({ severity: 'error', message: 'Apply failed. Please try again.' });
    }
    setApplying(false);
  }

  async function handleSyncOfficial() {
    setSyncingOfficial(true);
    setFeedback(null);

    try {
      const res = await apiFetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: ['EU', 'UN', 'US', 'UK'], mode }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 200 || res.status === 202) {
        setFeedback({
          severity: 'success',
          message: data.importId
            ? `Official sync started in background (Import #${data.importId}). Check Import History for progress.`
            : 'Official sources synchronization started.',
        });
      } else {
        setFeedback({ severity: 'error', message: data.error || 'Failed to trigger sync.' });
      }
    } catch (err) {
      console.error(err);
      setFeedback({ severity: 'error', message: 'Sync failed. Please try again.' });
    }
    setSyncingOfficial(false);
  }

  const applyDisabled = isBusy || !preview || (guardTripped && !overrideConfirmed);

  return (
    <Box>
      <Card sx={{ p: 2, mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
            <div>
              <Typography variant="h5" gutterBottom>
                Import Sanctions Lists
              </Typography>
              <Typography variant="body1" color="text.secondary">
                Upload one or multiple files (.xml, .csv) with automatic format detection and duplicate skipping.
              </Typography>
            </div>
            <Button
              variant="outlined"
              color="primary"
              startIcon={syncingOfficial ? <CircularProgress size={18} /> : <SyncIcon />}
              onClick={handleSyncOfficial}
              disabled={isBusy}
              sx={{ mt: { xs: 2, sm: 0 } }}
            >
              Sync Official Sources (EU/UN/US/UK)
            </Button>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="upload-source-label">Source</InputLabel>
              <Select
                labelId="upload-source-label"
                label="Source"
                value={source}
                onChange={(e: SelectChangeEvent) => handleSourceChange(e.target.value as SanctionSourceOption)}
                disabled={isBusy}
              >
                {SOURCES.map((s) => (
                  <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="upload-mode-label">Mode</InputLabel>
              <Select
                labelId="upload-mode-label"
                label="Mode"
                value={mode}
                onChange={(e: SelectChangeEvent) => handleModeChange(e.target.value as ImportMode)}
                disabled={isBusy}
              >
                <MenuItem value="append">Append</MenuItem>
                <MenuItem value="sync">Sync</MenuItem>
              </Select>
            </FormControl>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {mode === 'sync'
              ? 'Sync: this file replaces the entire source — any record of this source missing from the file will be delisted.'
              : 'Append: adds and updates records from this file. Nothing already in the database is ever delisted.'}
          </Typography>

          <Paper
            variant="outlined"
            sx={{
              p: 6,
              textAlign: 'center',
              cursor: isBusy ? 'default' : 'pointer',
              borderStyle: 'dashed',
              borderColor: 'primary.main',
              opacity: isBusy ? 0.6 : 1,
            }}
            component="label"
          >
            <input
              type="file"
              hidden
              multiple
              aria-label="Sanctions list file"
              onChange={handleFileSelected}
              accept=".csv,.xml"
              disabled={isBusy}
            />
            <CloudUploadIcon sx={{ fontSize: 60, color: 'primary.main', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              {previewing
                ? 'Previewing...'
                : applying
                ? 'Uploading & Processing...'
                : 'Click or Drag & Drop single or multiple files here'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Supported formats: EU XML, UN XML, US XML, UK XML, CSV
            </Typography>
          </Paper>

          {previewing && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {/* Single File Preview Card */}
          {preview && (
            <Card variant="outlined" sx={{ mt: 3, p: 2 }}>
              <Typography variant="h6" gutterBottom>
                Preview: {selectedFile?.name}
              </Typography>

              {preview.diffs.map((diff, i) => (
                <Box key={i} sx={{ mb: 2 }}>
                  {preview.diffs.length > 1 && (
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>{diff.source}</Typography>
                  )}
                  <DiffBucket label="Added" count={diff.counts.added} samples={diff.samples.added} />
                  <DiffBucket label="Updated" count={diff.counts.updated} samples={diff.samples.updated} />
                  <DiffBucket label="Unchanged" count={diff.counts.unchanged} samples={diff.samples.unchanged} />
                  <DiffBucket label="Delisted" count={diff.counts.delisted} samples={diff.samples.delisted} />

                  {diff.guardTripped && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        Refusing to delist {diff.counts.delisted} of {diff.activeCount} active {diff.source} records
                        by default — this looks like a truncated or wrong file. Confirm below to override and delist
                        anyway.
                      </Typography>
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={overrideConfirmed}
                            onChange={(e) => setOverrideConfirmed(e.target.checked)}
                          />
                        }
                        label="I understand — delist these records anyway"
                      />
                    </Alert>
                  )}
                </Box>
              ))}

              {totalDelisted > 0 && !guardTripped && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  This will delist {totalDelisted} record{totalDelisted === 1 ? '' : 's'}.
                </Alert>
              )}

              <Box sx={{ display: 'flex', gap: 2 }}>
                <Button
                  variant="contained"
                  onClick={handleApply}
                  disabled={applyDisabled}
                  startIcon={applying ? <CircularProgress size={18} color="inherit" /> : undefined}
                >
                  Apply
                </Button>
                <Button variant="text" onClick={resetForNextUpload} disabled={isBusy}>
                  Discard
                </Button>
              </Box>
            </Card>
          )}

          {/* Batch Upload Queue */}
          {batchQueue.length > 0 && (
            <Card variant="outlined" sx={{ mt: 3, p: 2 }}>
              <Typography variant="h6" gutterBottom>
                Batch Upload Queue ({batchQueue.length} files)
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>File</TableCell>
                      <TableCell>Size</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Details</TableCell>
                      <TableCell align="right">Action</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {batchQueue.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell><strong>{item.filename}</strong></TableCell>
                        <TableCell>{(item.size / 1024).toFixed(1)} KB</TableCell>
                        <TableCell>
                          {item.status === 'pending' && <Chip label="Pending" size="small" />}
                          {item.status === 'previewed' && <Chip label="Previewed" size="small" color="info" variant="outlined" />}
                          {item.status === 'uploading' && (
                            <Chip
                              icon={<CircularProgress size={14} color="inherit" />}
                              label="Uploading"
                              size="small"
                              color="primary"
                            />
                          )}
                          {item.status === 'applied' && <Chip label="Applied" size="small" color="success" />}
                          {item.status === 'skipped' && <Chip label="Skipped (Duplicate)" size="small" color="default" />}
                          {item.status === 'failed' && <Chip label="Failed" size="small" color="error" />}
                        </TableCell>
                        <TableCell>{item.message || '-'}</TableCell>
                        <TableCell align="right">
                          {item.duplicateImportId && (
                            <Button size="small" onClick={() => onViewImport(item.duplicateImportId!)}>
                              View Import
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {batchGuardTripped && (
                <Alert severity="warning" sx={{ mt: 2, mb: 1 }}>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    Refusing to delist records by default for one or more files in this batch — this looks like a truncated or wrong file. Confirm below to override and delist anyway.
                  </Typography>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={overrideConfirmed}
                        onChange={(e) => setOverrideConfirmed(e.target.checked)}
                      />
                    }
                    label="I understand — delist these records anyway"
                  />
                </Alert>
              )}

              {batchQueue.some((i) => i.status === 'previewed') && (
                <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
                  <Button
                    variant="contained"
                    onClick={handleApplyBatch}
                    disabled={isBusy || (batchGuardTripped && !overrideConfirmed)}
                    startIcon={applying ? <CircularProgress size={18} color="inherit" /> : undefined}
                  >
                    Apply ({batchQueue.filter((i) => i.status === 'previewed').length})
                  </Button>
                  <Button variant="text" onClick={() => setBatchQueue([])} disabled={isBusy}>
                    Discard
                  </Button>
                </Box>
              )}
            </Card>
          )}

          {feedback && (
            <Alert
              severity={feedback.severity}
              sx={{ mt: 3 }}
              onClose={() => setFeedback(null)}
              action={
                feedback.duplicateImportId ? (
                  <Button size="small" onClick={() => onViewImport(feedback.duplicateImportId!)}>
                    View import
                  </Button>
                ) : undefined
              }
            >
              {feedback.message}
            </Alert>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
