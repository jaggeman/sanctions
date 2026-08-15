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
  Paper,
  CircularProgress,
  IconButton
} from '@mui/material';
import type { PaletteMode } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SearchIcon from '@mui/icons-material/Search';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LogoutIcon from '@mui/icons-material/Logout';
import Login from './components/Login';

// Function to generate theme based on mode
const getTheme = (mode: PaletteMode) => createTheme({
  palette: {
    mode,
    ...(mode === 'dark'
      ? {
          // Dark Mode Palette
          primary: { main: '#90caf9' },
          secondary: { main: '#f48fb1' },
          background: { default: '#0a1929', paper: '#001e3c' },
        }
      : {
          // Light Mode Palette
          primary: { main: '#1976d2' },
          secondary: { main: '#9c27b0' },
          background: { default: '#f5f7fa', paper: '#ffffff' },
        }),
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h5: { fontWeight: 600 },
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

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUserEmail(null);
  };

  // App State
  const [tabValue, setTabValue] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      alert('Search failed');
    }
    setIsLoading(false);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', 'MANUAL_UPLOAD');
    
    setIsLoading(true);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        alert('File uploaded successfully! Import process has started.');
      } else {
        alert('Upload failed.');
      }
    } catch (err) {
      console.error(err);
      alert('Upload failed.');
    }
    setIsLoading(false);
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
      <AppBar position="static" elevation={0} sx={{ background: 'transparent', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontWeight: 'bold', color: 'primary.main' }}>
            Sanctions Intelligence
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
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
            <Tab label="Official EU Lists" />
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

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, gap: 3 }}>
              {results.map((r, i) => (
                <Box key={i}>
                  <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <CardContent sx={{ flexGrow: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                        <Chip label={r.source} size="small" color="primary" variant="outlined" />
                        <Chip label={r.type} size="small" color="error" variant="outlined" />
                      </Box>
                      <Typography variant="h6" component="h2" gutterBottom>
                        {r.primaryName}
                      </Typography>
                      {r.aliases && r.aliases.length > 0 && (
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          <strong>Aliases:</strong> {r.aliases.slice(0, 3).join(', ')}
                          {r.aliases.length > 3 ? '...' : ''}
                        </Typography>
                      )}
                      {r.birthDates && r.birthDates.length > 0 && (
                        <Typography variant="body2" color="text.secondary">
                          <strong>DOB:</strong> {r.birthDates.join(', ')}
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
          <Box>
            <Card sx={{ p: 2 }}>
              <CardContent>
                <Typography variant="h5" gutterBottom>
                  Import Sanctions List
                </Typography>
                <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
                  Upload CSV or XML files to sync with the database. Processing happens in the background.
                </Typography>
                
                <Paper 
                  variant="outlined" 
                  sx={{ 
                    mt: 4, 
                    p: 6, 
                    textAlign: 'center', 
                    cursor: 'pointer',
                    borderStyle: 'dashed',
                    borderColor: 'primary.main',
                    backgroundColor: mode === 'dark' ? 'rgba(144, 202, 249, 0.04)' : 'rgba(25, 118, 210, 0.04)',
                    transition: 'all 0.2s',
                    '&:hover': {
                      backgroundColor: mode === 'dark' ? 'rgba(144, 202, 249, 0.08)' : 'rgba(25, 118, 210, 0.08)'
                    }
                  }}
                  component="label"
                >
                  <input type="file" hidden onChange={handleUpload} accept=".csv,.xml" />
                  <CloudUploadIcon sx={{ fontSize: 60, color: 'primary.main', mb: 2 }} />
                  <Typography variant="h6" gutterBottom>
                    {isLoading ? 'Uploading...' : 'Click or Drag & Drop to upload files'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Supported formats: CSV, XML
                  </Typography>
                </Paper>
              </CardContent>
            </Card>
          </Box>
        )}

        {tabValue === 2 && (
          <Box>
            <Typography variant="h5" gutterBottom sx={{ mb: 3 }}>
              Official European Union Sanctions Lists
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}>
              
              <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <CardContent sx={{ flexGrow: 1 }}>
                  <Typography variant="h6" gutterBottom>
                    EU Sanctions Map
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    An interactive map and visual tool providing up-to-date information on all EU restrictive measures currently in place around the world.
                  </Typography>
                </CardContent>
                <Box sx={{ p: 2, pt: 0 }}>
                  <Button 
                    variant="outlined" 
                    fullWidth 
                    endIcon={<OpenInNewIcon />}
                    href="https://www.sanctionsmap.eu/#/main"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Map
                  </Button>
                </Box>
              </Card>

              <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <CardContent sx={{ flexGrow: 1 }}>
                  <Typography variant="h6" gutterBottom>
                    Consolidated Financial Sanctions
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    The official EU database of persons, groups, and entities subject to EU financial sanctions. Available through the EU Open Data portal.
                  </Typography>
                </CardContent>
                <Box sx={{ p: 2, pt: 0 }}>
                  <Button 
                    variant="outlined" 
                    fullWidth 
                    endIcon={<OpenInNewIcon />}
                    href="https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Dataset
                  </Button>
                </Box>
              </Card>

              <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <CardContent sx={{ flexGrow: 1 }}>
                  <Typography variant="h6" gutterBottom>
                    European Commission Policy
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Comprehensive information, guidance, and policy details regarding the adoption and implementation of EU restrictive measures.
                  </Typography>
                </CardContent>
                <Box sx={{ p: 2, pt: 0 }}>
                  <Button 
                    variant="outlined" 
                    fullWidth 
                    endIcon={<OpenInNewIcon />}
                    href="https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures_en"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read Policy
                  </Button>
                </Box>
              </Card>

            </Box>
          </Box>
        )}
      </Container>
    </ThemeProvider>
  );
}

export default App;
