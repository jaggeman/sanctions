import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Link,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { apiFetch } from './apiFetch';

interface ImportRecordData {
  importId: string;
  filename: string;
  source: string;
  format: string;
  fileGenerationDate?: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  status: 'pending' | 'parsing' | 'applied' | 'failed' | 'rejected';
  counts?: { parsed: number; uploaded: number };
  duplicateOfImportId?: string;
  error?: string;
}

interface SourceWebsiteInfo {
  name: string;
  authority: string;
  websiteUrl: string;
  downloadUrl?: string;
}

const SOURCE_WEBSITES: Record<string, SourceWebsiteInfo> = {
  EU: {
    name: 'Consolidated List of Sanctions',
    authority: 'European Commission (EU)',
    websiteUrl: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions',
    downloadUrl: 'https://webgate.ec.europa.eu/europeaid/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content',
  },
  UN: {
    name: 'UN Security Council Consolidated List',
    authority: 'United Nations Security Council',
    websiteUrl: 'https://www.un.org/securitycouncil/content/un-sc-consolidated-list',
    downloadUrl: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
  },
  US: {
    name: 'Specially Designated Nationals and Blocked Persons (SDN)',
    authority: 'US Department of the Treasury (OFAC)',
    websiteUrl: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
    downloadUrl: 'https://www.treasury.gov/ofac/downloads/sdn.xml',
  },
  UK: {
    name: 'The UK Sanctions List',
    authority: 'Foreign, Commonwealth & Development Office (FCDO)',
    websiteUrl: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
    downloadUrl: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
  },
  CH: {
    name: 'Swiss Overall List of Sanctions (SESAM)',
    authority: 'State Secretariat for Economic Affairs (SECO)',
    websiteUrl: 'https://www.seco.admin.ch/seco/en/home/Aussenwirtschaftspolitik_Wirtschaftliche_Zusammenarbeit/Wirtschaftsbeziehungen/exportkontrollen-und-sanktionen/sanktionen-embargos.html',
    downloadUrl: 'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction',
  },
};

function statusColor(status: ImportRecordData['status']): 'success' | 'error' | 'warning' | 'default' {
  if (status === 'applied') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'rejected') return 'warning';
  return 'default';
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

interface ImportHistoryTabProps {
  focusImportId?: string;
  onFocusConsumed?: () => void;
}

export default function ImportHistoryTab({ focusImportId, onFocusConsumed }: ImportHistoryTabProps = {}) {
  const [imports, setImports] = useState<ImportRecordData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ImportRecordData | null>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadCsv = async (importId: string) => {
    try {
      setDownloading(true);
      const res = await apiFetch(`/api/export?importId=${encodeURIComponent(importId)}&status=all`);
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sanctions-import-${importId}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error(err);
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/imports');
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        setImports(list);
        if (focusImportId) {
          const match = list.find((i: ImportRecordData) => i.importId === focusImportId);
          if (match) setSelected(match);
          onFocusConsumed?.();
        }
      } catch (err) {
        console.error(err);
        setError('Could not load import history.');
      }
      setLoading(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [focusImportId]);

  return (
    <Box>
      <Card sx={{ p: 2 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Import History
          </Typography>

          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          )}

          {error && <Alert severity="error">{error}</Alert>}

          {!loading && !error && imports.length === 0 && (
            <Typography variant="body1" color="text.secondary" sx={{ mt: 2 }}>
              No imports yet. Uploaded files will show up here.
            </Typography>
          )}

          {!loading && !error && imports.length > 0 && (
            <Box sx={{ overflowX: 'auto' }}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Filename</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Format</TableCell>
                    <TableCell>Uploaded</TableCell>
                    <TableCell>By</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {imports.map((imp) => (
                    <TableRow key={imp.importId} hover onClick={() => setSelected(imp)} sx={{ cursor: 'pointer' }}>
                      <TableCell>{imp.filename}</TableCell>
                      <TableCell>{imp.source}</TableCell>
                      <TableCell>{imp.format}</TableCell>
                      <TableCell>{formatDate(imp.uploadedAt)}</TableCell>
                      <TableCell>{imp.uploadedBy || '—'}</TableCell>
                      <TableCell>
                        <Chip label={imp.status} size="small" color={statusColor(imp.status)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onClose={() => setSelected(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{selected?.filename || selected?.importId}</DialogTitle>
        <DialogContent>
          {selected && (() => {
            const sourceKey = selected.source?.toUpperCase();
            const sourceInfo = sourceKey ? SOURCE_WEBSITES[sourceKey] : undefined;

            return (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Chip label={selected.source || 'Unknown'} color="primary" size="small" variant="outlined" />
                  <Chip label={selected.format} size="small" variant="outlined" />
                  <Chip label={selected.status} size="small" color={statusColor(selected.status)} />
                </Box>

                <Typography variant="body2">
                  <strong>Uploaded:</strong> {formatDate(selected.uploadedAt)} by {selected.uploadedBy || 'unknown'}
                </Typography>

                {selected.fileGenerationDate && (
                  <Typography variant="body2">
                    <strong>File Generation Date:</strong> {formatDate(selected.fileGenerationDate)}
                  </Typography>
                )}

                {sourceInfo ? (
                  <Box
                    sx={{
                      p: 1.5,
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                      Official Source Website & Download Link
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      <strong>Authority:</strong> {sourceInfo.authority} ({sourceInfo.name})
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      <Link
                        href={sourceInfo.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 0.5,
                          fontSize: '0.875rem',
                          textDecoration: 'none',
                          '&:hover': { textDecoration: 'underline' },
                        }}
                      >
                        Official Website / Portal <OpenInNewIcon sx={{ fontSize: 15 }} />
                      </Link>
                      {sourceInfo.downloadUrl && (
                        <Link
                          href={sourceInfo.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          sx={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 0.5,
                            fontSize: '0.875rem',
                            wordBreak: 'break-all',
                            textDecoration: 'none',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          Direct Data Download URL <OpenInNewIcon sx={{ fontSize: 15 }} />
                        </Link>
                      )}
                    </Box>
                  </Box>
                ) : (
                  <Box
                    sx={{
                      p: 1.5,
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                      Source Origin
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Manual upload / custom dataset (no external website).
                    </Typography>
                  </Box>
                )}

                {selected.status === 'applied' && selected.counts && (
                  <Typography variant="body2">
                    Parsed {selected.counts.parsed} record{selected.counts.parsed === 1 ? '' : 's'}, uploaded {selected.counts.uploaded}.
                  </Typography>
                )}
                {selected.status === 'failed' && selected.error && (
                  <Alert severity="error">{selected.error}</Alert>
                )}
                {selected.status === 'rejected' && selected.duplicateOfImportId && (
                  <Alert severity="warning">
                    Identical file already imported as import #{selected.duplicateOfImportId}.
                  </Alert>
                )}
              </Box>
            );
          })()}
        </DialogContent>
        <DialogActions>
          {selected?.status === 'applied' && (
            <Button
              variant="contained"
              startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
              disabled={downloading}
              onClick={() => handleDownloadCsv(selected.importId)}
            >
              Export CSV
            </Button>
          )}
          <Button onClick={() => setSelected(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

