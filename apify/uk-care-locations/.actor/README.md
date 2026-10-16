# UK Care Providers Directory (CQC)

**~57,000 regulated health and social care locations in England** — care homes, nursing homes, hospitals, GP practices, dentists, homecare agencies, hospices, ambulance services — with service types, specialisms/service-user bands, provider name and id, trading address and postcode area, local authority, region, the date of the latest CQC check and the CQC page URL. From the Care Quality Commission's official weekly directory (Open Government Licence v3).

## What people use it for
- **Recruitment and staffing** — every care home and homecare agency in a region.
- **Medical and catering suppliers, insurers, healthtech** — prospect lists by service type.
- **Care-home brokers and researchers** — provider estates, recent inspections.

## Output (one item per location)
`location_id, provider_id, name, also_known_as, address, postcode, outward_code, website, service_types, latest_check_date, specialisms, provider_name, local_authority, region, cqc_url`

## Data posture
Location-level data as published by CQC; the public phone-number column and registered-manager names are not included. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the location records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
