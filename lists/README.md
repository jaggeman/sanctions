# `lists/` — real sanctions-list source data

This directory holds the actual, full-size sanctions list exports downloaded
from each source's official publication endpoint. It is **not tracked in
git** (large binary/text data, changes on every re-download) — see
`.gitignore`.

## Why these files exist

Per `CLAUDE.md`'s testing policy: test fixtures must be *carved verbatim* out
of a genuine source file, never hand-written from reading the parser code.
These are the genuine source files that fixtures under `tests/fixtures/` are
carved from, and the files new parsers get run against once (aggregate
counts compared against the source) before being called correct.

`C:/Sanctions/downloads/` holds the same kind of thing — real cached
downloads used the same way. There's no hard rule for which directory a new
download goes in; this one just accumulated the EU-format files and is where
manually-fetched lists get dropped.

## Current files

| File | Source | Format | Official page | Notes |
|---|---|---|---|---|
| `20260805-FULL-1_0.csv` (+ numbered copies) | EU Financial Sanctions Database (FSD) | CSV | https://webgate.ec.europa.eu/fsd/fsf | Same export downloaded multiple times — the numbered copies were used to verify import dedup (issue #7's "six identical uploads" acceptance test uses these). |
| `20260805-FULL-1_1.csv`, `20260805-FULL-1_1(xsd).xml` (+ copies) | EU FSD | CSV / XML | same as above | v1.1 schema export; the XML is what `src/importer/parsers/eu.ts` actually parses in production. |
| `20260805-FULL.pdf` | EU FSD | PDF | same as above | Human-readable version, not parsed. |
| `eu_sanktionslista_screening_2026-08-15.csv` | EU FSD | CSV | same as above | A separately-sourced EU screening export, used for cross-checking. |
| `uk_sanctions.xml` | UK Sanctions List (FCDO) | XML | https://www.gov.uk/government/publications/the-uk-sanctions-list | Downloaded 2026-08-16 for issue #99. Direct download: `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml`. 6 334 `<Designation>` records (4 027 Individual / 1 643 Entity / 664 Ship) — matches the counts issue #99 verified. |

`C:/Sanctions/downloads/` additionally has:

| File | Source | Format | Official page |
|---|---|---|---|
| `un_sanctions.xml` | UN Security Council Consolidated List | XML | https://www.un.org/securitycouncil/content/un-sc-consolidated-list |
| `us_sdn.xml` | US Treasury OFAC Specially Designated Nationals (SDN) List | XML | https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists |

## How to get a fresh copy

Each parser's own file documents the exact download URL it expects (see
`src/importer/fetcher.ts`'s `SOURCE_URLS` for the URLs the app itself
fetches on a schedule / on manual import). To re-download by hand:

```bash
# EU FSD (XML, v1.1)
curl -sSL -o lists/eu_sample_full.xml "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=..."
# (EU requires a session token from the FSD web UI — there's no stable
# unauthenticated URL; download manually from https://webgate.ec.europa.eu/fsd/fsf)

# UN Security Council Consolidated List
curl -sSL -o downloads/un_sanctions.xml "https://scsanctions.un.org/resources/xml/en/consolidated.xml"

# US OFAC SDN List
curl -sSL -o downloads/us_sdn.xml "https://sanctionslistservice.ofac.treas.gov/entities?format=XML"

# UK Sanctions List (FCDO) — stable, no auth needed
curl -sSL -o lists/uk_sanctions.xml "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml"
```

## Using these files

From any worktree, reference them by absolute path
(`C:/Sanctions/lists/...` or `C:/Sanctions/downloads/...`) — they live
outside any single worktree/checkout, shared across all of them, same as
any other machine-local cache.

Typical uses:
1. **Carving a fixture**: pull one complete, real record out verbatim into
   `tests/fixtures/<source>_sample.xml`, with a comment noting which real
   record it came from (id/line) and why (e.g. "has a genuine leading-zero
   document number").
2. **Full-file verification**: run the parser against the real file once
   (throwaway script or test, not committed) and compare aggregate counts
   — total records, type split, field-presence counts — against numbers
   independently measured from the raw file (`grep -c`, etc.). This is what
   catches a systemic mapping error a hand-written fixture can't (see
   CLAUDE.md §1's EU-parser incident).
3. **Memory profiling**: for a new large-file parser, measure peak RSS
   against the real file before calling a streaming implementation
   sufficient (see issue #31's methodology).
