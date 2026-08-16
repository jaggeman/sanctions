import React, { useState, useMemo, useEffect } from 'react';
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  AppBar,
  Toolbar,
  Typography,
  Container,
  Box,
  Tabs,
  Tab,
  Card,
  CardContent,
  TextField,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Alert
} from '@mui/material';
import type { PaletteMode } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ApiTokensTab from './ApiTokensTab';
import ImportHistoryTab from './ImportHistoryTab';
import RecordDetail from './RecordDetail';
import UploadTab from './UploadTab';
import EuListsTab from './EuListsTab';
import HelpManualTab from './HelpManualTab';
import LogoutIcon from '@mui/icons-material/Logout';
import Login from './components/Login';
import { apiFetch, setOnSessionExpired } from './apiFetch';

// Brand bar stays a consistent deep navy in both light and dark mode —
// a fixed identity color reads as more "product" than a bar that changes
// with the toggle, and it's what actually separates the header from the
// page (previously: a transparent bar with bold blue text as the only
// signal, which is the "doesn't look professional" complaint this fixes).
const BRAND_BAR = '#0F172A';
const BRAND_ACCENT = '#60A5FA';

// Function to generate theme based on mode
const getTheme = (mode: PaletteMode) => createTheme({
  palette: {
    mode,
    ...(mode === 'dark'
      ? {
          // Dark Mode Palette
          primary: { main: '#60A5FA' },
          secondary: { main: '#A78BFA' },
          background: { default: '#0B1220', paper: '#111C2E' },
        }
      : {
          // Light Mode Palette
          primary: { main: '#2563EB' },
          secondary: { main: '#7C3AED' },
          background: { default: '#F8FAFC', paper: '#ffffff' },
        }),
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h5: { fontWeight: 600 },
    h6: { fontWeight: 700, letterSpacing: '-0.01em' },
  },
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          boxShadow: mode === 'dark' 
            ? '0 4px 20px 0 rgba(0,0,0,0.4)' 
            : '0 4px 20px 0 rgba(0,0,0,0.05)',
        },
      },
    },
  },
});

function App() {
  // Theme State
  const [mode, setMode] = useState<PaletteMode>('dark');
  
  // Load saved theme preference on mount
  useEffect(() => {
    const savedMode = localStorage.getItem('themeMode') as PaletteMode;
    if (savedMode) {
      setMode(savedMode);
    }
  }, []);

  const toggleColorMode = () => {
    setMode((prevMode) => {
      const newMode = prevMode === 'light' ? 'dark' : 'light';
      localStorage.setItem('themeMode', newMode);
      return newMode;
    });
  };

  // Generate theme dynamically
  const theme = useMemo(() => getTheme(mode), [mode]);

  // Auth State
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUserEmail(data?.email ?? null))
      .catch(() => setUserEmail(null))
      .finally(() => setAuthChecked(true));
  }, []);

  // issue #59: any apiFetch call that gets a 401 (session expired or
  // invalidated server-side) routes the user back to Login, app-wide.
  useEffect(() => {
    setOnSessionExpired(() => setUserEmail(null));
    return () => setOnSessionExpired(null);
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUserEmail(null);
  };

  // App State
  const [tabValue, setTabValue] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [historyFocusId, setHistoryFocusId] = useState<string | undefined>(undefined);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      if (res.status === 401) {
        // Session expired — apiFetch's onSessionExpired callback (registered
        // above) already flips userEmail back to null and returns to Login.
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

  if (!authChecked) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CircularProgress />
        </Box>
      </ThemeProvider>
    );
  }

  if (!userEmail) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Login onLoggedIn={setUserEmail} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar
        position="static"
        elevation={0}
        sx={{
          background: BRAND_BAR,
          color: '#fff',
          boxShadow: '0 1px 0 0 rgba(255,255,255,0.06), 0 4px 16px 0 rgba(0,0,0,0.25)',
        }}
      >
        <Toolbar>
          <ShieldOutlinedIcon sx={{ mr: 1.25, color: BRAND_ACCENT, fontSize: 26 }} />
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, color: '#fff' }}>
            Sanctions Intelligence
          </Typography>
          <Typography variant="body2" sx={{ mr: 1, color: 'rgba(255,255,255,0.7)' }}>
            {userEmail}
          </Typography>
          <IconButton sx={{ ml: 1 }} onClick={toggleColorMode} color="inherit">
            {mode === 'dark' ? <Brightness7Icon /> : <Brightness4Icon />}
          </IconButton>
          <IconButton sx={{ ml: 1 }} onClick={handleLogout} color="inherit" aria-label="Log out">
            <LogoutIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ mt: 4, mb: 8 }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 4 }}>
          <Tabs value={tabValue} onChange={handleTabChange} aria-label="app tabs">
            <Tab label="Search" />
            <Tab label="Upload Lists" />
            <Tab label="Import History" />
            <Tab label="Official EU Lists" />
            <Tab label="API Tokens" />
            <Tab label="Help & Manual" />
          </Tabs>
        </Box>

        {tabValue === 0 && (
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
                    onClick={() => setSelectedRecordId(r.id)}
                  >
                    <CardContent sx={{ flexGrow: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                        <Chip label={r.source} size="small" color="primary" variant="outlined" />
                        <Chip label={r.type} size="small" color="error" variant="outlined" />
                      </Box>
                      <Typography variant="h6" component="h2" gutterBottom>
                        {r.primaryName}
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
                      {r.aliases && r.aliases.length > 0 && (
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          <strong>Aliases:</strong> {r.aliases.slice(0, 3).join(', ')}
                          {r.aliases.length > 3 ? '...' : ''}
                        </Typography>
                      )}
                      {r.datesOfBirth && r.datesOfBirth.length > 0 && (
                        <Typography variant="body2" color="text.secondary">
                          <strong>DOB:</strong> {r.datesOfBirth.join(', ')}
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
        )}

        {tabValue === 1 && (
          <UploadTab
            onViewImport={(importId) => {
              setHistoryFocusId(importId);
              setTabValue(2);
            }}
          />
        )}

        {tabValue === 2 && <ImportHistoryTab focusImportId={historyFocusId} />}

        {tabValue === 3 && <EuListsTab />}

        {tabValue === 4 && <ApiTokensTab />}

        {tabValue === 5 && <HelpManualTab />}
      </Container>

      <RecordDetail recordId={selectedRecordId} onClose={() => setSelectedRecordId(null)} />
    </ThemeProvider>
  );
}

export default App;
