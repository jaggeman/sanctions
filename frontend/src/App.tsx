import React, { useState, useMemo, useEffect, Suspense } from 'react';
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
  CircularProgress,
  IconButton,
} from '@mui/material';
import type { PaletteMode } from '@mui/material';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import LogoutIcon from '@mui/icons-material/Logout';
import Login from './components/Login';
import TabErrorBoundary from './components/TabErrorBoundary';
import { setOnSessionExpired } from './apiFetch';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Issue #228 & Issue #238: Code splitting & lazy loading of tab components with auto-recovery on chunk failure
const SearchTab = lazyWithRetry(() => import('./SearchTab'), 'SearchTab');
const UploadTab = lazyWithRetry(() => import('./UploadTab'), 'UploadTab');
const ImportHistoryTab = lazyWithRetry(() => import('./ImportHistoryTab'), 'ImportHistoryTab');
const OfficialSourcesTab = lazyWithRetry(() => import('./OfficialSourcesTab'), 'OfficialSourcesTab');
const ApiTokensTab = lazyWithRetry(() => import('./ApiTokensTab'), 'ApiTokensTab');
const HelpManualTab = lazyWithRetry(() => import('./HelpManualTab'), 'HelpManualTab');
const DriftStatusTab = lazyWithRetry(() => import('./DriftStatusTab'), 'DriftStatusTab');
const RecordDetail = lazyWithRetry(() => import('./RecordDetail'), 'RecordDetail');

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

function TabLoadingFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
      <CircularProgress />
    </Box>
  );
}

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
            <Tab label="Official Sources" />
            <Tab label="API Tokens" />
            <Tab label="Help & Manual" />
            <Tab label="Drift status" />
          </Tabs>
        </Box>

        <TabErrorBoundary>
          <Suspense fallback={<TabLoadingFallback />}>
            <Box sx={{ display: tabValue === 0 ? 'block' : 'none' }}>
              <SearchTab onSelectRecord={setSelectedRecordId} />
            </Box>

            {tabValue === 1 && (
              <UploadTab
                onViewImport={(importId) => {
                  setHistoryFocusId(importId);
                  setTabValue(2);
                }}
              />
            )}

            {tabValue === 2 && <ImportHistoryTab focusImportId={historyFocusId} />}

            {tabValue === 3 && <OfficialSourcesTab />}

            {tabValue === 4 && <ApiTokensTab />}

            {tabValue === 5 && <HelpManualTab />}

            {tabValue === 6 && <DriftStatusTab />}
          </Suspense>
        </TabErrorBoundary>
      </Container>

      <TabErrorBoundary>
        <Suspense fallback={null}>
          <RecordDetail recordId={selectedRecordId} onClose={() => setSelectedRecordId(null)} />
        </Suspense>
      </TabErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
