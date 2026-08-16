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
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { apiFetch } from './apiFetch';

type SanctionSource = 'EU' | 'UN' | 'US' | 'PEP' | 'CUSTOM';
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

interface UploadTabProps {
  onViewImport: (importId: string) => void;
}

const SOURCES: SanctionSource[] = ['EU', 'UN', 'US', 'PEP', 'CUSTOM'];

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
  const [source, setSource] = useState<SanctionSource>('EU');
  const [mode, setMode] = useState<ImportMode>('append');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<{
    severity: 'success' | 'error' | 'warning';
    message: string;
    duplicateImportId?: string;
  } | null>(null);

  const guardTripped = preview?.diffs.some((d) => d.guardTripped) ?? false;
  const totalDelisted = preview?.diffs.reduce((sum, d) => sum + d.counts.delisted, 0) ?? 0;
  const isBusy = previewing || applying;

  function resetForNextUpload() {
    setSelectedFile(null);
    setPreview(null);
    setOverrideConfirmed(false);
  }

  async function runUpload(file: File, dryRun: boolean, force: boolean) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', source);
    formData.append('mode', mode);
    formData.append('dryRun', dryRun ? 'true' : 'false');
    if (force) formData.append('force', 'true');

    const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later

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

  const applyDisabled = isBusy || !preview || (guardTripped && !overrideConfirmed);

  return (
    <Box>
      <Card sx={{ p: 2 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Import Sanctions List
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
            Selecting a file previews what it would change. Nothing is written until you click Apply.
          </Typography>

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="upload-source-label">Source</InputLabel>
              <Select
                labelId="upload-source-label"
                label="Source"
                value={source}
                onChange={(e: SelectChangeEvent) => setSource(e.target.value as SanctionSource)}
                disabled={isBusy}
              >
                {SOURCES.map((s) => (
                  <MenuItem key={s} value={s}>{s}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="upload-mode-label">Mode</InputLabel>
              <Select
                labelId="upload-mode-label"
                label="Mode"
                value={mode}
                onChange={(e: SelectChangeEvent) => setMode(e.target.value as ImportMode)}
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
              aria-label="Sanctions list file"
              onChange={handleFileSelected}
              accept=".csv,.xml"
              disabled={isBusy}
            />
            <CloudUploadIcon sx={{ fontSize: 60, color: 'primary.main', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              {previewing ? 'Previewing...' : applying ? 'Applying...' : 'Click or Drag & Drop to upload files'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Supported formats: CSV, XML
            </Typography>
          </Paper>

          {previewing && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}

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
