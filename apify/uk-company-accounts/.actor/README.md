# UK Company Accounts: Net Assets, Cash, Staff (Companies House)

**Is this company solvent, and how big is it?** The headline figures from the accounts UK companies file electronically at Companies House (about 60 % of the 2.2 million sets filed a year), read every morning from the official free Accounts Data Product (iXBRL; Open Government Licence v3). One item per company and balance-sheet date:

- **who and when** — company number, registered name as tagged, balance-sheet date, period start, the dormant flag, the date of the daily file that carried the filing, a link to the company's filing history.
- **the balance sheet** — net assets (negative = net liabilities) and the tag it was read from (the net-assets line, or total equity where a micro-entity tags only that), cash at bank and in hand, creditors due within one year.
- **size** — average number of employees; turnover and profit where the company files them (most small companies file a balance sheet only, so these are usually empty).
- **the trend** — the same figures for the prior period, from the comparatives in the same accounts.

The register builds up from November 2026: each day adds the accounts registered the working day before (roughly 8,000–11,000 a day, up to 80,000 at the end of September).

## What people use it for
- **Credit and supplier checks** — negative net assets (`net_assets_max = -1`), cash against creditors due within a year, the change on the prior year.
- **Lead lists** — cash-rich or growing companies by threshold (`cash_min`, `employees_min`) among the accounts filed this week.
- **Monitoring** — each new set of accounts as it is filed (changes mode), for the company numbers you watch.

## Output (one item per set of accounts)
`company_number, company, balance_sheet_date, period_start, dormant, net_assets, net_assets_source, cash, creditors_within_one_year, employees, turnover, profit_loss, prior_balance_sheet_date, prior_net_assets, prior_cash, prior_creditors_within_one_year, prior_employees, prior_turnover, prior_profit_loss, file_date, filing_history_url`

## Data posture
Organisation-level money and counts from the public register, exactly as each company tagged them (a figure the filer did not tag is empty, never estimated). Director names, signatories and the narrative notes are never ingested. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds); the latest figures also ride gankdat's Companies House company lookup as `financials`.

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the accounts added or changed since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` and `changed_at` next to the figures. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for what changed.
