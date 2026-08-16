import { Box, Card, CardContent, Typography, Button } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

/**
 * "Official EU Lists" tab — static links to the EU's own sanctions
 * resources. No state/handlers; extracted verbatim from App.tsx (issue #27,
 * criterion 3) as its own component, matching the ApiTokensTab/
 * ImportHistoryTab/RecordDetail pattern.
 */
function EuListsTab() {
  return (
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
  );
}

export default EuListsTab;
