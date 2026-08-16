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
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
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
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {truncated
            ? `Showing ${results.length} of ${totalMatches} matches — narrow your search or raise the limit to see more.`
            : `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`}
        </Typography>
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
        {results.length === 0 && !isLoading && (
          <Box sx={{ gridColumn: '1 / -1' }}>
            <Typography variant="body1" color="text.secondary" align="center" sx={{ mt: 4 }}>
              No results found. Enter a query to begin your search.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
