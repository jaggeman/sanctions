import { useMemo, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import DownloadIcon from '@mui/icons-material/Download';
import { apiFetch } from './apiFetch';

// issue #46: SanctionRecord no longer has flat primaryName/aliases/
// datesOfBirth fields — every result from the API now carries `names`
// (NameAlias[], primary first) and `birthDates` (BirthDate[]) instead. These
// three mirror the equivalent helpers in src/shared/types.ts on the backend;
// duplicated rather than imported since the frontend build doesn't share
// modules with the backend one.
interface NameAliasLike { wholeName: string }
interface BirthDateLike { raw?: string; year?: number; month?: number; day?: number; yearRangeFrom?: number; yearRangeTo?: number }

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function primaryNameOf(names: NameAliasLike[] | undefined): string {
  return names?.[0]?.wholeName || 'Unknown Name';
}

function renderScoreTooltip(r: any) {
  const b = r.scoreBreakdown;
  if (!b) {
    return `${r.score}% match`;
  }
  if (b.mechanism === 'passport_id') {
    return (
      <Box sx={{ p: 0.5, maxWidth: 280 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'inherit' }}>
          Passport / ID Match (100%)
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          Matched directly on official identification document number.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 0.5, maxWidth: 320 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'inherit' }}>
          Score Breakdown: {r.score}%
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {b.dobBoostApplied && (
            <Chip label="+10% DOB" size="small" color="primary" sx={{ height: 18, fontSize: '0.65rem' }} />
          )}
          {b.countryBoostApplied && (
            <Chip label="+10% Country" size="small" color="success" sx={{ height: 18, fontSize: '0.65rem' }} />
          )}
          {b.countryPenaltyApplied && (
            <Chip label="-20% Country Mismatch" size="small" color="error" sx={{ height: 18, fontSize: '0.65rem' }} />
          )}
        </Box>
      </Box>

      {b.matchedWords && b.matchedWords.length > 0 && (
        <Box sx={{ mt: 0.5, mb: 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block' }}>
            Matched terms:
          </Typography>
          {b.matchedWords.map((mw: any, idx: number) => (
            <Typography key={idx} variant="caption" sx={{ display: 'block', pl: 1 }}>
              • <strong>"{mw.queryWord}"</strong> ➔ <strong>"{mw.candidateWord}"</strong> ({mw.score}%)
            </Typography>
          ))}
        </Box>
      )}

      {b.unmatchedCandidateWords && b.unmatchedCandidateWords.length > 0 && (
        <Box sx={{ mt: 0.5, mb: 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', opacity: 0.85 }}>
            Unexplained name parts:
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', pl: 1, opacity: 0.85 }}>
            {b.unmatchedCandidateWords
              .map((uw: any) => `${uw.word}${uw.isParticle ? ' (particle)' : ''}`)
              .join(', ')}
          </Typography>
        </Box>
      )}

      {b.unmatchedQueryWords && b.unmatchedQueryWords.length > 0 && (
        <Box sx={{ mt: 0.5, mb: 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', color: 'warning.light' }}>
            Unmatched query terms:
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', pl: 1, color: 'warning.light' }}>
            {b.unmatchedQueryWords.join(', ')}
          </Typography>
        </Box>
      )}

      {b.countryMatchDetails && b.countryMatchDetails.status !== 'no_query' && (
        <Box sx={{ mt: 0.5, mb: 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', opacity: 0.85 }}>
            Country comparison:
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', pl: 1, opacity: 0.85 }}>
            Query: {b.countryMatchDetails.queryCountry || 'N/A'} vs Candidate: [
            {b.countryMatchDetails.candidateCountries?.join(', ') || 'none listed'}]
          </Typography>
        </Box>
      )}

      <Box sx={{ mt: 1, pt: 0.5, borderTop: '1px solid rgba(255,255,255,0.2)', display: 'flex', gap: 2 }}>
        <Typography variant="caption" sx={{ opacity: 0.8 }}>
          Query coverage: {Math.round(b.queryCoverage * 100)}%
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.8 }}>
          Name coverage: {Math.round(b.candidateCoverage * 100)}%
        </Typography>
      </Box>
    </Box>
  );
}

function aliasNamesOf(names: NameAliasLike[] | undefined): string[] {
  return (names || []).slice(1).map((n) => n.wholeName);
}

function formatBirthDates(birthDates: BirthDateLike[] | undefined): string[] {
  return (birthDates || [])
    .map((b) => {
      if (b.raw) return b.raw;
      if (b.yearRangeFrom || b.yearRangeTo) return `${b.yearRangeFrom ?? '?'}-${b.yearRangeTo ?? '?'}`;
      if (b.year) return [b.year, b.month, b.day].filter((p) => p !== undefined).join('-');
      return '';
    })
    .filter(Boolean);
}

interface SearchTabProps {
  onSelectRecord: (id: string) => void;
}

/**
 * Results render as a dense table rather than a card grid: the job here is
 * scanning and comparing a result set, and columns line score/source/type up
 * for that in a way three-across cards do not. Sorting is client-side over
 * the page the API already returned — it deliberately does NOT re-query, so
 * it can never reorder a *different* set of records than the one on screen.
 * When `truncated` is set, the message above the table still says so.
 */
type SortKey = 'score' | 'name' | 'source' | 'type';
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'score', label: 'Score', numeric: true },
  { key: 'name', label: 'Name' },
  { key: null, label: 'Matched on' },
  { key: null, label: 'Aliases' },
  { key: 'source', label: 'Source' },
  { key: 'type', label: 'Type' },
  { key: null, label: 'Date of birth' },
  { key: null, label: 'Status' },
];

export default function SearchTab({ onSelectRecord }: SearchTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [countryQuery, setCountryQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [totalMatches, setTotalMatches] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [sourcesSearched, setSourcesSearched] = useState<string[]>([]);

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
    setHasSearched(true);
    setSearchError(null);
    try {
      let url = `/api/search?q=${encodeURIComponent(searchQuery)}`;
      if (countryQuery.trim()) {
        url += `&country=${encodeURIComponent(countryQuery.trim())}`;
      }
      const res = await apiFetch(url);
      if (res.status === 401) {
        // Session expired — apiFetch's onSessionExpired callback (registered
        // by App) already flips userEmail back to null and returns to Login.
        // Don't also render "No results found" for what is actually an
        // expired session, not an empty result (issue #59).
        return;
      }
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        setSearchError(errorData?.error || 'Search failed. Please try again.');
        return;
      }
      const data = await res.json();
      setResults(Array.isArray(data.results) ? data.results : []);
      setTotalMatches(typeof data.totalMatches === 'number' ? data.totalMatches : 0);
      setTruncated(Boolean(data.truncated));
      setTookMs(typeof data.tookMs === 'number' ? data.tookMs : null);
      setSourcesSearched(Array.isArray(data.sourcesSearched) ? data.sourcesSearched : []);
    } catch (err) {
      console.error(err);
      setSearchError('Search failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // A new column starts ascending; clicking the active column flips it. Score
  // is the exception — it starts descending, since "best match first" is the
  // only useful default for a relevance-ranked list.
  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'score' ? 'desc' : 'asc');
  };

  const sortedResults = useMemo(() => {
    const factor = sortDir === 'asc' ? 1 : -1;
    return [...results].sort((a, b) => {
      if (sortKey === 'score') return ((a.score ?? 0) - (b.score ?? 0)) * factor;
      const av =
        sortKey === 'name' ? primaryNameOf(a.names) : String(a[sortKey] ?? '');
      const bv =
        sortKey === 'name' ? primaryNameOf(b.names) : String(b[sortKey] ?? '');
      return av.localeCompare(bv) * factor;
    });
  }, [results, sortKey, sortDir]);

  const handleExportResultsCsv = () => {
    const headers = ['id', 'source', 'type', 'primaryName', 'aliases', 'score', 'matchedAlias', 'status', 'birthDates'];
    const escapeField = (val: unknown) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };
    const rows = results.map((r) => [
      escapeField(r.id),
      escapeField(r.source),
      escapeField(r.type),
      escapeField(primaryNameOf(r.names)),
      escapeField(aliasNamesOf(r.names).join('; ')),
      escapeField(r.score ?? ''),
      escapeField(r.matchedAlias ?? ''),
      escapeField(r.status || 'active'),
      escapeField(formatBirthDates(r.birthDates).join('; ')),
    ].join(','));

    const csvContent = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sanctions-search-${encodeURIComponent(searchQuery || 'results')}.csv`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  return (
    <Box>
      <Card sx={{ mb: 4, p: 2 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Search Entities
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mt: 2 }}>
            <TextField
              fullWidth
              variant="outlined"
              placeholder="Search by name, passport, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              disabled={isLoading}
            />
            <TextField
              sx={{ minWidth: { sm: 240 } }}
              variant="outlined"
              placeholder="Country / Nationality (e.g. SE, RU)"
              value={countryQuery}
              onChange={(e) => setCountryQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              disabled={isLoading}
            />
            <Button
              variant="contained"
              size="large"
              startIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : <SearchIcon />}
              onClick={handleSearch}
              disabled={isLoading}
              sx={{ whiteSpace: 'nowrap' }}
            >
              Search
            </Button>
          </Box>
        </CardContent>
      </Card>

      {searchError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSearchError(null)}>
          {searchError}
        </Alert>
      )}

      {results.length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {truncated
              ? `Showing ${results.length} of ${totalMatches} matches — narrow your search or raise the limit to see more.`
              : `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`}
            {tookMs !== null &&
              ` · search took ${formatDuration(tookMs)}${
                sourcesSearched.length > 0
                  ? ` across ${sourcesSearched.length} database${sourcesSearched.length === 1 ? '' : 's'}`
                  : ''
              }`}
          </Typography>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadIcon />}
            onClick={handleExportResultsCsv}
          >
            Export Results (CSV)
          </Button>
        </Box>
      )}

      {results.length > 0 && (
        <TableContainer component={Paper} sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {COLUMNS.map((col) => (
                  <TableCell
                    key={col.label}
                    align={col.numeric ? 'right' : 'left'}
                    sortDirection={col.key && sortKey === col.key ? sortDir : false}
                    onClick={col.key ? () => handleSort(col.key as SortKey) : undefined}
                    sx={{
                      whiteSpace: 'nowrap',
                      fontWeight: 600,
                      cursor: col.key ? 'pointer' : 'default',
                      userSelect: 'none',
                    }}
                  >
                    {col.key ? (
                      <TableSortLabel
                        active={sortKey === col.key}
                        direction={sortKey === col.key ? sortDir : 'asc'}
                      >
                        {col.label}
                      </TableSortLabel>
                    ) : (
                      col.label
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedResults.map((r) => {
                const aliases = aliasNamesOf(r.names);
                const primary = primaryNameOf(r.names);
                // Only worth a column when it differs from the primary name —
                // otherwise it is the same string twice on every single row.
                const matchedOn = r.matchedAlias && r.matchedAlias !== primary ? r.matchedAlias : '';
                const dobs = formatBirthDates(r.birthDates);
                return (
                  <TableRow
                    key={r.id}
                    hover
                    onClick={() => onSelectRecord(r.id)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell align="right">
                      {typeof r.score === 'number' ? (
                        <Tooltip title={renderScoreTooltip(r)} arrow placement="top">
                          <Chip
                            label={`${r.score}%`}
                            size="small"
                            color={r.score >= 90 ? 'success' : r.score >= 75 ? 'warning' : 'default'}
                            sx={{ cursor: 'help' }}
                          />
                        </Tooltip>
                      ) : (
                        ''
                      )}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 500 }}>{primary}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{matchedOn}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', maxWidth: 260 }}>
                      {aliases.slice(0, 3).join(', ')}
                      {aliases.length > 3 ? '…' : ''}
                    </TableCell>
                    <TableCell>
                      <Chip label={r.source} size="small" color="primary" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Chip label={r.type} size="small" color="error" variant="outlined" />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                      {dobs.join(', ')}
                    </TableCell>
                    <TableCell>
                      {r.status === 'delisted' && (
                        <Chip label="Delisted" size="small" variant="outlined" />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {results.length === 0 && !isLoading && !searchError && (
        <Typography variant="body1" color="text.secondary" align="center" sx={{ mt: 4 }}>
          {hasSearched
            ? 'No results found. Try adjusting your search query or filters.'
            : 'Enter a name, passport number, or entity ID above to search among 32,000+ sanctions records.'}
        </Typography>
      )}
    </Box>
  );
}
