import { Box, Card, CardContent, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import InfoIcon from '@mui/icons-material/Info';

/**
 * "Help & Manual" tab — static in-app documentation. No state/handlers;
 * extracted verbatim from App.tsx (issue #27, criterion 3) as its own
 * component, matching the ApiTokensTab/ImportHistoryTab/RecordDetail pattern.
 */
function HelpManualTab() {
  return (
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
              The <strong>Official Sources</strong> tab provides direct links to the official governmental portals and registries across the EU, UN, US OFAC, UK FCDO/OFSI, and Swiss SECO.
            </Typography>
          </CardContent>
        </Card>

      </Box>
    </Box>
  );
}

export default HelpManualTab;
