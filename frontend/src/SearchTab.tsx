import { useState } from 'react';
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

function primaryNameOf(names: NameAliasLike[] | undefined): string {
  return names?.[0]?.wholeName || 'Unknown Name';
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

export default function SearchTab({ onSelectRecord }: SearchTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
    setHasSearched(true);
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
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
    } catch (err) {
      console.error(err);
      setSearchError('Search failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

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
          <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
            <TextField
              fullWidth
              variant="outlined"
              placeholder="Search by name, passport, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              disabled={isLoading}
            />
            <Button
              variant="contained"
              size="large"
              startIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : <SearchIcon />}
              onClick={handleSearch}
              disabled={isLoading}
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

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, gap: 3 }}>
        {results.map((r, i) => (
          <Box key={i}>
            <Card
              sx={{ height: '100%', display: 'flex', flexDirection: 'column', cursor: 'pointer' }}
              onClick={() => onSelectRecord(r.id)}
            >
              <CardContent sx={{ flexGrow: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                  <Chip label={r.source} size="small" color="primary" variant="outlined" />
                  <Chip label={r.type} size="small" color="error" variant="outlined" />
                </Box>
                <Typography variant="h6" component="h2" gutterBottom>
                  {primaryNameOf(r.names)}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                  {typeof r.score === 'number' && (
                    <Chip
                      label={`${r.score}% match${r.matchedAlias ? ` — "${r.matchedAlias}"` : ''}`}
                      size="small"
                      color={r.score >= 90 ? 'success' : r.score >= 75 ? 'warning' : 'default'}
                    />
                  )}
                  {r.status === 'delisted' && (
                    <Chip label="Delisted" size="small" color="default" variant="outlined" />
                  )}
                </Box>
                {aliasNamesOf(r.names).length > 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    <strong>Aliases:</strong> {aliasNamesOf(r.names).slice(0, 3).join(', ')}
                    {aliasNamesOf(r.names).length > 3 ? '...' : ''}
                  </Typography>
                )}
                {formatBirthDates(r.birthDates).length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    <strong>DOB:</strong> {formatBirthDates(r.birthDates).join(', ')}
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Box>
        ))}
        {results.length === 0 && !isLoading && !searchError && (
          <Box sx={{ gridColumn: '1 / -1' }}>
            <Typography variant="body1" color="text.secondary" align="center" sx={{ mt: 4 }}>
              {hasSearched
                ? 'No results found. Try adjusting your search query or filters.'
                : 'Enter a name, passport number, or entity ID above to search among 32,000+ sanctions records.'}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
