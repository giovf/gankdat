# UK Payment Practices Reports (Large Companies, Days to Pay)

**Will this customer pay on time?** Every statutory payment practices report filed by a large UK company or LLP since 2017 (two of: £54m turnover, £27m balance sheet, 250 employees — around 9,000 reporters, twice a year), from the official GOV.UK payment practices reporting service (Open Government Licence v3), refreshed daily. One item per report:

- **who and when** — company number and name, reporting period, filing date, the report's own page.
- **how fast they pay** — average days to pay; share of invoices paid within 30 days, 31–60 days and after 60 days; share not paid within the agreed terms (paid late); share disputed.
- **terms** — shortest and longest standard payment terms, maximum contractual period, whether terms changed in the period and whether suppliers were told.
- **policy answers** — payment-code signatory (Prompt Payment Code / Fair Payment Code), e-invoicing offered, supply-chain finance offered, charges for staying on the supplier list.

## What people use it for
- **Supplier due diligence** — before taking a large customer on credit: days to pay and the late share, for every period since 2017.
- **Credit control and factoring** — prompt and slow payers by threshold (`average_days_to_pay_max`, `not_paid_within_terms_pct_min`).
- **Procurement and policy** — payment-code signatories, e-invoicing and supply-chain finance adoption across the register.
- **Change monitoring** — each new report as it is filed (gankdat's daily change feed).

## Output (one item per report)
`report_id, company_number, company, period_start, period_end, filed_on, average_days_to_pay, paid_within_30_days_pct, paid_31_to_60_days_pct, paid_after_60_days_pct, not_paid_within_terms_pct, disputed_pct, shortest_standard_terms_days, longest_standard_terms_days, max_contractual_days, terms_changed, suppliers_notified, qualifying_contracts, payments_made, construction_contracts, construction_retention_clauses, participates_in_payment_codes, e_invoicing_offered, supply_chain_financing_offered, supplier_list_charges_policy, supplier_list_charges_made, report_url`

## Data posture
Statutory public register, organisation level: the statistics and yes/no answers each company publishes. The narrative answers (free-text terms, retention-clause descriptions, dispute-resolution process) and total-value columns are never ingested. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds); the same figures ride gankdat's Companies House company lookup as `payment_practices`.

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the reports added, removed or changed since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the report's fields. Your filters still apply, so one scheduled run is a watch on the companies you sell to — **Schedules → daily** on this actor — and you pay only for the reports that changed.
