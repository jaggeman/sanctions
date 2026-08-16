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
  Button,
  CircularProgress,
  IconButton,
} from '@mui/material';
import type { PaletteMode } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SearchIcon from '@mui/icons-material/Search';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import InfoIcon from '@mui/icons-material/Info';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import ApiTokensTab from './ApiTokensTab';
import ImportHistoryTab from './ImportHistoryTab';
import RecordDetail from './RecordDetail';
import SearchTab from './SearchTab';
import UploadTab from './UploadTab';
import LogoutIcon from '@mui/icons-material/Logout';
import Login from './components/Login';
import { setOnSessionExpired } from './apiFetch';

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
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [historyFocusId, setHistoryFocusId] = useState<string | undefined>(undefined);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
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

        {tabValue === 0 && <SearchTab onSelectRecord={setSelectedRecordId} />}

        {tabValue === 1 && (
          <UploadTab
            onViewImport={(importId) => {
              setHistoryFocusId(importId);
              setTabValue(2);
            }}
          />
        )}

        {tabValue === 2 && <ImportHistoryTab focusImportId={historyFocusId} />}

        {tabValue === 3 && (
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

        {tabValue === 4 && <ApiTokensTab />}

        {tabValue === 5 && (
          <Box>
            <Typography variant="h5" gutterBottom sx={{ mb: 3 }}>
              User Manual & Help
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}>
              
              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <SearchIcon color="primary" sx={{ mr: 1.5, fontSize: 32 }} />
                    <Typography variant="h6">How to Search</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    The <strong>Search</strong> tab allows you to query the entire unified sanctions database. You can search by entering an individual's name, an entity name, a passport number, or an ID number.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    The results will display the primary name along with any known aliases. If available, dates of birth are also shown. Each card uses colored chips to indicate which official list the entity was sourced from (e.g., EU, UN, US OFAC) and their classification (e.g., PERSON or ENTITY). Since the search uses fuzzy matching, each result also includes a match score percentage and, for non-exact hits, the specific alias that matched — this works for names written in non-Latin scripts (e.g. Arabic, Cyrillic) as well.
                  </Typography>
                </CardContent>
              </Card>

              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <CloudUploadIcon color="primary" sx={{ mr: 1.5, fontSize: 32 }} />
                    <Typography variant="h6">Uploading Lists</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    The <strong>Upload Lists</strong> tab enables you to manually synchronize new sanctions files into the system database.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Currently supported formats include structured <strong>CSV</strong> files and <strong>XML</strong> format lists, covering EU, UN, US, PEP, and CUSTOM sources. Uploading an identical file twice is rejected as a duplicate, with a link to the original import in the <strong>Import History</strong> tab.
                  </Typography>
                </CardContent>
              </Card>

              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <VpnKeyIcon color="primary" sx={{ mr: 1.5, fontSize: 32 }} />
                    <Typography variant="h6">Managing API Tokens</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    The <strong>API Tokens</strong> tab lets you create, list, and revoke tokens for programmatic access to the search and import APIs.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Each token is minted with an explicit <strong>read</strong> or <strong>write</strong> scope — grant only the scope a given integration actually needs, and revoke a token immediately if it's no longer in use or may have leaked.
                  </Typography>
                </CardContent>
              </Card>

              <Card sx={{ height: '100%' }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <InfoIcon color="primary" sx={{ mr: 1.5, fontSize: 32 }} />
                    <Typography variant="h6">Official Sources</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    While this tool centralizes information, you should always consult the original sources when making critical decisions.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    The <strong>Official EU Lists</strong> tab provides direct links to the EU Sanctions Map and the EU's Open Data Portal where you can download the consolidated financial sanctions datasets directly.
                  </Typography>
                </CardContent>
              </Card>

            </Box>
          </Box>
        )}
      </Container>

      <RecordDetail recordId={selectedRecordId} onClose={() => setSelectedRecordId(null)} />
    </ThemeProvider>
  );
}

export default App;
