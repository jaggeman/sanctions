import { Box, Card, CardContent, Typography, Button, Chip, Stack } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

interface OfficialSourceResource {
  title: string;
  source: string;
  sourceLabel: string;
  color: 'primary' | 'secondary' | 'info' | 'warning' | 'success' | 'default';
  description: string;
  url: string;
  buttonLabel: string;
}

const RESOURCES: OfficialSourceResource[] = [
  // European Union (EU)
  {
    title: 'EU Sanctions Map',
    source: 'EU',
    sourceLabel: 'European Union',
    color: 'primary',
    description:
      'An interactive map and visual tool providing up-to-date information on all EU restrictive measures currently in place around the world.',
    url: 'https://www.sanctionsmap.eu/#/main',
    buttonLabel: 'Open Map',
  },
  {
    title: 'EU Consolidated Financial Sanctions',
    source: 'EU',
    sourceLabel: 'European Union',
    color: 'primary',
    description:
      'The official EU database of persons, groups, and entities subject to EU financial sanctions. Available through the EU Open Data portal.',
    url: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions',
    buttonLabel: 'Open EU Dataset',
  },
  {
    title: 'European Commission Policy',
    source: 'EU',
    sourceLabel: 'European Union',
    color: 'primary',
    description:
      'Comprehensive information, guidance, and policy details regarding the adoption and implementation of EU restrictive measures.',
    url: 'https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures_en',
    buttonLabel: 'Read Policy',
  },

  // United Nations (UN)
  {
    title: 'UN Security Council Consolidated List',
    source: 'UN',
    sourceLabel: 'United Nations',
    color: 'info',
    description:
      'The official United Nations Security Council Consolidated List covering all individuals and entities subject to measures imposed by the Security Council.',
    url: 'https://www.un.org/securitycouncil/content/un-sc-consolidated-list',
    buttonLabel: 'View UN List',
  },
  {
    title: 'UN Sanctions Committees Portal',
    source: 'UN',
    sourceLabel: 'United Nations',
    color: 'info',
    description:
      'Information, mandate overviews, and listing/delisting procedures across all active UN Security Council Sanctions Committees.',
    url: 'https://www.un.org/securitycouncil/sanctions/information',
    buttonLabel: 'UN Committees',
  },

  // United States (US - OFAC)
  {
    title: 'OFAC Sanctions List Search',
    source: 'US',
    sourceLabel: 'United States (OFAC)',
    color: 'warning',
    description:
      'The US Department of the Treasury (OFAC) official search tool designed to facilitate searching the SDN and Consolidated Sanctions lists.',
    url: 'https://sanctionssearch.ofac.treas.gov/',
    buttonLabel: 'Search OFAC',
  },
  {
    title: 'OFAC Specially Designated Nationals (SDN)',
    source: 'US',
    sourceLabel: 'United States (OFAC)',
    color: 'warning',
    description:
      'Direct access to official OFAC Specially Designated Nationals and Blocked Persons list publications, XML/CSV downloads, and program details.',
    url: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
    buttonLabel: 'OFAC SDN Portal',
  },

  // United Kingdom (UK)
  {
    title: 'The UK Sanctions List (FCDO)',
    source: 'UK',
    sourceLabel: 'United Kingdom (FCDO)',
    color: 'secondary',
    description:
      'The Foreign, Commonwealth & Development Office (FCDO) comprehensive list of all individuals, entities, and ships designated under the Sanctions Act 2018.',
    url: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
    buttonLabel: 'View UK List',
  },
  {
    title: 'OFSI Consolidated Financial Sanctions',
    source: 'UK',
    sourceLabel: 'United Kingdom (OFSI)',
    color: 'secondary',
    description:
      'HM Treasury Office of Financial Sanctions Implementation (OFSI) consolidated list of targets subject to asset freeze and financial restrictions.',
    url: 'https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets',
    buttonLabel: 'OFSI Portal',
  },

  // Switzerland (CH - SECO)
  {
    title: 'SECO SESAM Sanctions Database',
    source: 'CH',
    sourceLabel: 'Switzerland (SECO)',
    color: 'success',
    description:
      'The Swiss State Secretariat for Economic Affairs (SECO) SESAM online search portal and database for Swiss sanctions and targeted measures.',
    url: 'https://www.sesam.search.admin.ch/',
    buttonLabel: 'Open SESAM',
  },
  {
    title: 'SECO Embargoes & Sanctions Overview',
    source: 'CH',
    sourceLabel: 'Switzerland (SECO)',
    color: 'success',
    description:
      'Legal regulations, ordinances, and country-specific embargo measures enacted under the Swiss Federal Embargo Act (EmbA).',
    url: 'https://www.seco.admin.ch/seco/en/home/Aussenwirtschaftspolitik_Wirtschaftliche_Zusammenarbeit/Wirtschaftsbeziehungen/exportkontrollen-und-sanktionen/sanktionen-embargos.html',
    buttonLabel: 'SECO Regulations',
  },

  // Ukraine (UA — NSDC State Register of Sanctions, issue #287)
  {
    title: '🇺🇦 State Register of Sanctions (РНБО)',
    source: 'UA',
    sourceLabel: 'Ukraine (NSDC)',
    color: 'secondary',
    description:
      'The official Ukrainian National Security and Defense Council (РНБО/NSDC) State Register of Sanctions — covering ~22,000 sanctioned individuals and entities under Presidential Decrees.',
    url: 'https://drs.nsdc.gov.ua',
    buttonLabel: 'Open NSDC Register',
  },
  {
    title: '🇺🇦 NSDC Sanctions API',
    source: 'UA',
    sourceLabel: 'Ukraine (NSDC)',
    color: 'secondary',
    description:
      'Machine-readable REST API for the Ukrainian State Register of Sanctions (OAS 3.0 spec). Requires API key — request access at sanctions@rnbo.gov.ua.',
    url: 'https://api-drs.nsdc.gov.ua',
    buttonLabel: 'API Docs',
  },
];

/**
 * "Official Sources" tab — direct links to official international sanctions
 * authorities and registries (EU, UN, US OFAC, UK FCDO/OFSI, and Swiss SECO).
 */
export function OfficialSourcesTab() {
  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" gutterBottom>
          Official Sanctions Lists & Sources
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Direct access to the official governmental portals, registries, and documentation published by each sanctions authority ingested by the platform.
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}>
        {RESOURCES.map((item) => (
          <Card key={item.title} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <CardContent sx={{ flexGrow: 1 }}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                <Typography variant="h6" component="div">
                  {item.title}
                </Typography>
                <Chip label={item.source} size="small" color={item.color} variant="outlined" sx={{ fontWeight: 600 }} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5, fontWeight: 500 }}>
                {item.sourceLabel}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {item.description}
              </Typography>
            </CardContent>
            <Box sx={{ p: 2, pt: 0 }}>
              <Button
                variant="outlined"
                fullWidth
                endIcon={<OpenInNewIcon />}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.buttonLabel}
              </Button>
            </Box>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

export default OfficialSourcesTab;
