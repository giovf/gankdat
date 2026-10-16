# UK Schools & Colleges Directory (GIAS + Ofsted)

**Every school, academy, college and nursery in England** — from the Department for Education's official Get Information About Schools register, joined by URN to Ofsted's published inspection outcomes. URN, name, establishment type and phase, open/closed status, local authority and region, address and postcode area, website, capacity and pupils on roll, statutory age range, academy trust, open and close dates, the latest Ofsted rating and inspection date, and the GIAS page URL. Open Government Licence v3.

## What people use it for
- **Edtech and school suppliers** — prospect lists by phase, size, region or trust.
- **Teacher recruitment and tutoring** — every secondary in a county, with pupil numbers.
- **MAT and education analysts** — trust estates, Ofsted outcomes, openings and closures.

## Output (one item per establishment)
`urn, name, establishment_type, phase, status, local_authority, region, address, town, postcode, outward_code, website, school_capacity, pupils, statutory_low_age, statutory_high_age, trust_name, trust_id, open_date, close_date, ofsted_rating, ofsted_last_inspection, gias_url`

## Data posture
Establishment-level data as published by DfE and Ofsted. Head teacher names and the telephone column are dropped at ingest, and the GIAS governors extract is never used. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the school records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
