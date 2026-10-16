# UK Charities Register (Charity Commission)

**~184,000 registered charities** in England & Wales with charity and organisation numbers, type (CIO, charitable company, trust…), registration date, reporting status, latest financial year end, **latest income and expenditure**, postcode area, company number, website and insolvency/administration flags. From the Charity Commission's daily public extract (Open Government Licence v3), refreshed daily.

## What people use it for
- **Prospecting** for fundraising SaaS, payroll-giving and corporate-giving platforms (filter by income band and area).
- **Grant-maker and KYB due diligence** — reporting status, insolvency flags, latest accounts period.
- **New registrations** by date for sales teams.

## Output (one item per charity)
`organisation_number, registered_charity_number, linked_charity_number, name, charity_type, registration_status, date_of_registration, reporting_status, latest_financial_period_end, latest_income, latest_expenditure, postcode, outward_code, company_number, website, insolvent, in_administration, is_cio, gift_aid, has_land, activities`

## Data posture
Organisation-level only: contact address lines, phone, email and trustee names are never included. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds).

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the charity records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
