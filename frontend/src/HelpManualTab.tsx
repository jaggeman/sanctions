import type { ReactElement, ReactNode } from 'react';
import { Box, Card, CardContent, Divider, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import HistoryIcon from '@mui/icons-material/History';
import PublicIcon from '@mui/icons-material/Public';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import MenuBookIcon from '@mui/icons-material/MenuBook';

interface HelpSection {
  icon: ReactElement;
  title: string;
  accent: string;
  paragraphs: ReactNode[];
}

const SECTIONS: HelpSection[] = [
  {
    icon: <SearchIcon sx={{ fontSize: 30 }} />,
    title: 'How to Search',
    accent: '#1565c0',
    paragraphs: [
      <>
        The <strong>Search</strong> tab queries the entire unified sanctions database in one place. Search by an
        individual's name, an entity name, a passport number, or any other ID number.
      </>,
      <>
        Results show the primary name plus any known aliases and, when available, dates of birth. Colored chips mark
        which official list an entity was sourced from (EU, UN, US OFAC, UK, or CH) and its classification (PERSON or
        ENTITY). Fuzzy matching means every result carries a match score percentage and, for non-exact hits, the
        specific alias that matched — including names written in non-Latin scripts such as Arabic or Cyrillic.
      </>,
      <>
        Any result set can be downloaded directly with the <strong>Export Results (CSV)</strong> button, so a search
        can be shared or archived outside the app.
      </>,
    ],
  },
  {
    icon: <CloudUploadIcon sx={{ fontSize: 30 }} />,
    title: 'Uploading Lists',
    accent: '#2e7d32',
    paragraphs: [
      <>
        The <strong>Upload Lists</strong> tab lets you manually synchronize new sanctions files into the system
        database.
      </>,
      <>
        Supported formats are structured <strong>CSV</strong> and <strong>XML</strong> lists, covering EU, UN, US, UK,
        CH, PEP, and CUSTOM sources. Uploading a file that exactly matches a previous import is rejected as a
        duplicate, with a link straight to the original import in the <strong>Import History</strong> tab.
      </>,
    ],
  },
  {
    icon: <HistoryIcon sx={{ fontSize: 30 }} />,
    title: 'Import History',
    accent: '#6a1b9a',
    paragraphs: [
      <>
        The <strong>Import History</strong> tab lists every import that has been run — manual uploads and scheduled
        automatic fetches alike — with its status: <strong>applied</strong>, <strong>pending</strong>,{' '}
        <strong>parsing</strong>, <strong>failed</strong>, or <strong>rejected</strong> (duplicate).
      </>,
      <>
        Selecting an import shows how many records were added, updated, or skipped, and surfaces the parser error for
        a failed import or the original import a duplicate points to. Any completed import can be downloaded as a{' '}
        <strong>CSV</strong> for audit purposes.
      </>,
    ],
  },
  {
    icon: <PublicIcon sx={{ fontSize: 30 }} />,
    title: 'Official Sources',
    accent: '#ef6c00',
    paragraphs: [
      <>
        While this tool centralizes information for convenience, always consult the original sources when making
        critical decisions.
      </>,
      <>
        The <strong>Official Sources</strong> tab links directly to the official governmental portals and registries
        behind every list the system ingests: the <strong>EU</strong> Sanctions Map and Consolidated Financial
        Sanctions list, the <strong>UN</strong> Security Council Consolidated List, <strong>US</strong> OFAC,{' '}
        <strong>UK</strong> FCDO/OFSI, and <strong>Swiss SECO</strong>.
      </>,
    ],
  },
  {
    icon: <VpnKeyIcon sx={{ fontSize: 30 }} />,
    title: 'Managing API Tokens',
    accent: '#ad1457',
    paragraphs: [
      <>
        The <strong>API Tokens</strong> tab lets you create, list, and revoke tokens for programmatic access to the
        search and import APIs.
      </>,
      <>
        Every token is minted with an explicit <strong>read</strong> or <strong>write</strong> scope — grant only the
        scope an integration actually needs, and revoke a token immediately if it's no longer in use or may have
        leaked.
      </>,
    ],
  },
  {
    icon: <MonitorHeartIcon sx={{ fontSize: 30 }} />,
    title: 'Drift Status',
    accent: '#00838f',
    paragraphs: [
      <>
        The <strong>Drift Status</strong> tab is a live operational dashboard: database connectivity and latency,
        deployed Cloud Functions and their schedules, and a timeline of recent releases.
      </>,
      <>
        Use it to confirm the system is healthy, to see which scheduled auto-fetch jobs are configured, and to check
        what was last deployed and when.
      </>,
    ],
  },
];

/**
 * "Help & Manual" tab — static in-app documentation, one card per app tab.
 */
function HelpManualTab() {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
        <MenuBookIcon color="primary" sx={{ fontSize: 34 }} />
        <Typography variant="h5">User Manual & Help</Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        A quick reference for every tab in the application.
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr', lg: '1fr 1fr 1fr' },
          gap: 3,
        }}
      >
        {SECTIONS.map((section) => (
          <Card
            key={section.title}
            variant="outlined"
            sx={{
              height: '100%',
              borderTop: 4,
              borderTopColor: section.accent,
              transition: 'box-shadow 0.2s ease, transform 0.2s ease',
              '&:hover': { boxShadow: 4, transform: 'translateY(-2px)' },
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    bgcolor: `${section.accent}1a`,
                    color: section.accent,
                  }}
                >
                  {section.icon}
                </Box>
                <Typography variant="h6">{section.title}</Typography>
              </Box>
              <Divider sx={{ mb: 1.5 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                {section.paragraphs.map((paragraph, index) => (
                  <Typography key={index} variant="body2" color="text.secondary">
                    {paragraph}
                  </Typography>
                ))}
              </Box>
            </CardContent>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

export default HelpManualTab;
