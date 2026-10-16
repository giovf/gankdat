# UK Licensed Visa Sponsors Register (Home Office)

**~143,000 licence rows** (one per organisation × immigration route) from the official Home Office register of Worker and Temporary Worker sponsors: organisation name, town, county, sponsor type, licence rating (A / B / Provisional / Premium) and route (Skilled Worker, Global Business Mobility, Creative Worker, …). Republished most working days (Open Government Licence v3).

## What people use it for
- **Recruiters and job boards** — employers that can sponsor visas, by town and route.
- **Immigration advisers and relocation services** — verify a sponsor and its rating.
- **HR / compliance SaaS** — monitor licence ratings.

## Output (one item per organisation × route)
`organisation, town, county, sponsor_type, rating, route`

No personal data. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds — new licences and rating changes).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the sponsor records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
