# UK Gender Pay Gap Reports (Employers 250+, by Company Number)

**What is this employer's gender pay gap?** The figures every UK employer of 250 or more must publish each year, from the official GOV.UK gender pay gap service (Open Government Licence v3), refreshed daily. One item per employer and reporting year:

- **who and when** — employer, Companies House number, SIC codes, reporting year (2025 = 2025/26), due date, submission date and whether it was late.
- **the gap** — mean and median difference in hourly pay, mean and median difference in bonus pay (% of men's pay; negative means women are paid more).
- **the shape** — share of men and women who received a bonus, and in each of the four pay quartiles.
- **size** — the employer's size band.

## What people use it for
- **ESG and supplier screening** — a company's gap by its Companies House number, with the previous year beside it.
- **Recruitment and employer research** — employers in a sector (SIC code) by gap.
- **Journalism and policy** — late reporters, the widest gaps, year-on-year movement.
- **Change monitoring** — each report as it is submitted (gankdat's daily change feed).

## Output (one item per employer and year)
`employer_id, reporting_year, reporting_period, employer, company_number, sic_codes, mean_hourly_pct, median_hourly_pct, mean_bonus_pct, median_bonus_pct, male_bonus_pct, female_bonus_pct, male_lower_quartile_pct, female_lower_quartile_pct, male_lower_middle_quartile_pct, female_lower_middle_quartile_pct, male_upper_middle_quartile_pct, female_upper_middle_quartile_pct, male_top_quartile_pct, female_top_quartile_pct, employer_size, submitted_late, due_date, submitted_on`

## Data posture
Statutory public reports, employer level. The responsible person's name and job title and the employer's address are never ingested. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds); the latest report also rides gankdat's Companies House company lookup as `esg.gender_pay_gap`.

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the reports added or changed since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` and `changed_at`. Your filters still apply, so one scheduled daily run is a watch on the employers you follow, and you pay only for what changed.
