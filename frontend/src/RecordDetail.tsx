import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Box,
  Typography,
  Chip,
  Divider,
  CircularProgress,
  Alert,
  Link,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { apiFetch } from './apiFetch';

interface NameAlias {
  wholeName: string;
  strong: boolean;
}

interface Identification {
  number: string;
  typeDescription?: string;
  knownFalse?: boolean;
  knownExpired?: boolean;
  reportedLost?: boolean;
  revokedByIssuer?: boolean;
  diplomatic?: boolean;
}

interface Address {
  fullAddress?: string;
  street?: string;
  city?: string;
  country?: string;
}

interface Regulation {
  numberTitle?: string;
  programme?: string;
  url?: string;
}

interface RecordDetailData {
  id: string;
  // issue #46: SanctionRecord no longer sends flat primaryName/aliases —
  // `names` (below) is the only source now and is always present.
  names?: NameAlias[];
  source?: string;
  type?: string;
  status?: 'active' | 'delisted';
  listedAt?: string;
  delistedAt?: string;
  identifications?: Identification[];
  addresses?: Address[];
  citizenships?: string[];
  regulation?: Regulation;
  sanctionReason?: string;
}

interface RecordVersionEntry {
  importId: string;
  changedAt: string;
  changeType: 'created' | 'updated' | 'delisted' | 'relisted';
}

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function idFlags(id: Identification): string[] {
  const flags: string[] = [];
  if (id.knownFalse) flags.push('Known false');
  if (id.knownExpired) flags.push('Known expired');
  if (id.reportedLost) flags.push('Reported lost');
  if (id.revokedByIssuer) flags.push('Revoked by issuer');
  if (id.diplomatic) flags.push('Diplomatic');
  return flags;
}

interface DecisionEntry {
  entityId: string;
  subjectId: string;
  verdict: 'false_positive' | 'true_positive';
  decidedBy: string;
  decidedAt: string;
  notes?: string;
}

export default function RecordDetail({ recordId, onClose }: { recordId: string | null; onClose: () => void }) {
  const [record, setRecord] = useState<RecordDetailData | null>(null);
  const [versions, setVersions] = useState<RecordVersionEntry[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setVersions([]);
      setDecisions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [recordRes, versionsRes, decisionsRes] = await Promise.all([
          apiFetch(`/api/sanctions/${encodeURIComponent(recordId)}`),
          apiFetch(`/api/sanctions/${encodeURIComponent(recordId)}/versions`),
          apiFetch(`/api/decisions/${encodeURIComponent(recordId)}`),
        ]);
        if (!recordRes.ok) throw new Error(`Server returned ${recordRes.status}`);
        const recordData = await recordRes.json();
        const versionsData = versionsRes.ok ? await versionsRes.json() : [];
        const decisionsData = decisionsRes.ok ? await decisionsRes.json() : [];
        if (cancelled) return;
        setRecord(recordData);
        setVersions(Array.isArray(versionsData) ? versionsData : []);
        setDecisions(Array.isArray(decisionsData) ? decisionsData : []);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError('Could not load this record.');
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [recordId]);

  if (!recordId) return null;

  const isDelisted = record?.status === 'delisted';

  return (
    <Dialog open={!!recordId} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{record?.names?.[0]?.wholeName || 'Record detail'}</span>
        <IconButton aria-label="Close" onClick={onClose} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        {!loading && !error && record && (
          <Box>
            <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
              {record.source && <Chip label={record.source} size="small" color="primary" variant="outlined" />}
              {record.type && <Chip label={record.type} size="small" color="error" variant="outlined" />}
              <Chip
                label={isDelisted ? 'Delisted' : 'Active'}
                size="small"
                color={isDelisted ? 'default' : 'success'}
              />
            </Box>

            {isDelisted && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Delisted at: {formatDate(record.delistedAt)}
              </Typography>
            )}
            {record.listedAt && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                First listed: {formatDate(record.listedAt)}
              </Typography>
            )}

            {/* Names */}
            <Typography variant="subtitle1" gutterBottom>Names</Typography>
            {record.names && record.names.length > 0 ? (
              <List dense>
                {record.names.map((n, i) => (
                  <ListItem key={i} disableGutters>
                    <ListItemText
                      primary={n.wholeName}
                      secondary={n.strong ? 'strong' : 'weak'}
                    />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                No name data.
              </Typography>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Identifications */}
            {record.identifications && record.identifications.length > 0 && (
              <>
                <Typography variant="subtitle1" gutterBottom>Identifications</Typography>
                <List dense>
                  {record.identifications.map((id, i) => (
                    <ListItem key={i} disableGutters>
                      <ListItemText
                        primary={`${id.number}${id.typeDescription ? ` (${id.typeDescription})` : ''}`}
                        secondary={idFlags(id).length > 0 ? idFlags(id).join(', ') : undefined}
                      />
                    </ListItem>
                  ))}
                </List>
                <Divider sx={{ my: 2 }} />
              </>
            )}

            {/* Addresses */}
            {record.addresses && record.addresses.length > 0 && (
              <>
                <Typography variant="subtitle1" gutterBottom>Addresses</Typography>
                <List dense>
                  {record.addresses.map((a, i) => (
                    <ListItem key={i} disableGutters>
                      <ListItemText primary={a.fullAddress || [a.street, a.city, a.country].filter(Boolean).join(', ')} />
                    </ListItem>
                  ))}
                </List>
                <Divider sx={{ my: 2 }} />
              </>
            )}

            {/* Citizenships */}
            {record.citizenships && record.citizenships.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle1" gutterBottom>Citizenships</Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {record.citizenships.map((c, i) => (
                    <Chip key={i} label={c} size="small" variant="outlined" />
                  ))}
                </Box>
              </Box>
            )}

            {/* Regulation */}
            {record.regulation && (record.regulation.numberTitle || record.regulation.url) && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle1" gutterBottom>Regulation</Typography>
                {record.regulation.url ? (
                  <Link href={record.regulation.url} target="_blank" rel="noopener noreferrer">
                    {record.regulation.numberTitle || record.regulation.url}
                  </Link>
                ) : (
                  <Typography variant="body2">{record.regulation.numberTitle}</Typography>
                )}
              </Box>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Decisions History (issue #320) */}
            <Typography variant="subtitle1" gutterBottom sx={{ mt: 2 }}>Compliance Adjudications & Decisions</Typography>
            {decisions.length > 0 ? (
              <List dense>
                {decisions.map((d, i) => (
                  <ListItem key={i} disableGutters sx={{ alignItems: 'flex-start' }}>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                          <Chip
                            label={d.verdict === 'false_positive' ? 'False Positive' : 'True Positive'}
                            size="small"
                            color={d.verdict === 'false_positive' ? 'success' : 'error'}
                            sx={{ fontWeight: 600 }}
                          />
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            Subject: {d.subjectId}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            by {d.decidedBy} ({formatDate(d.decidedAt)})
                          </Typography>
                        </Box>
                      }
                      secondary={d.notes ? `Notes: ${d.notes}` : undefined}
                    />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Typography variant="body2" color="text.secondary">No compliance decisions recorded yet.</Typography>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Version trail */}
            <Typography variant="subtitle1" gutterBottom>Version History</Typography>
            {versions.length > 0 ? (
              <List dense>
                {versions.map((v, i) => (
                  <ListItem key={i} disableGutters>
                    <ListItemText
                      primary={`${v.changeType} — ${formatDate(v.changedAt)}`}
                      secondary={`Import ${v.importId}`}
                    />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Typography variant="body2" color="text.secondary">No version history yet.</Typography>
            )}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
