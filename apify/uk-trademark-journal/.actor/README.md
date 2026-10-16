# UK Trade Mark Applications Weekly (IPO Journal Watch)

**Every UK trade mark application published for opposition** — UK filings and international registrations designating the UK, from the Intellectual Property Office's weekly Trade Marks Journal (Open Government Licence v3). Application number, mark text and type, Nice classes and goods/services, applicant organisation and country, representative firm, filing and priority dates, journal issue, publication date and the **two-month opposition deadline**. Rolling 52 weekly issues, refreshed the morning after each Friday's journal.

## What people use it for
- **Trade mark watching** — find new applications similar to your mark (by word, class or goods) while the opposition window is still open, instead of paying a watch service £180–320 per mark per year.
- **IP firms and attorneys** — weekly prospect lists of applicants filing without a representative, by class or country.
- **Brand and market research** — who is filing what in a class; new entrants by sector.
- **Compliance and onboarding** — check a counterparty's recent filings.

## Output (one item per published application)
`application_number, journal_number, publication_date, opposition_deadline, mark_text, mark_type, classes, class_count, goods_services, applicant_type, applicant, applicant_country, representative, filing_date, priority_date, origin, international_registration, series_count, section, journal_url, register_url`

## Data posture
Public-register data reduced to organisation level: an applicant or representative name is kept only when it is an organisation; individual applicants are recorded as "individual or unincorporated" without a name, addresses are reduced to the country, and mark images are never stored. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, weekly change feed).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the applications published since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
