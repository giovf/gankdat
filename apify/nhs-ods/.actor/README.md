# NHS Organisations Directory (ODS: GPs, Trusts, Pharmacies)

**Every organisation on the NHS register for England** — GP practices, NHS trusts and their hospital sites, community pharmacies, dental practices and independent-sector healthcare providers, from NHS England's official Organisation Data Service (ODS) nightly extracts. ODS code, name, organisation type, active/closed status, NHS England region and integrated care board codes, address and postcode area, open and close dates, parent organisation (commissioning sub-ICB location or trust) and, for GP practices, the prescribing setting. Open Government Licence v3.

## What people use it for
- **Healthtech and medical suppliers** — prospect lists of practices, pharmacies or trusts by region, ICB or town.
- **Pharma and device field teams** — territory lists keyed by ODS code, the identifier the NHS itself uses.
- **KYB and onboarding** — check a GP practice, pharmacy or provider code is active before contracting.
- **Analysts** — closures, mergers and openings by date; trust estates by site.

## Output (one item per organisation)
`ods_code, name, org_type, status, national_grouping, health_geography, address, town, county, postcode, outward_code, open_date, close_date, sub_type, parent_code, parent_joined, parent_left, prescribing_setting, ord_url`

## Data posture
Organisation-level data as published by NHS England's Organisation Data Service. The telephone column is dropped at ingest and the practitioner files (named GPs and dentists) are never used. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the organisation records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
