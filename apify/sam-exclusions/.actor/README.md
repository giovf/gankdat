# US Federal Exclusions (SAM.gov)

Every active exclusion on the official US SAM.gov list — individuals, firms, special entities and vessels barred from federal awards — with classification, exclusion type and program, **excluding agency**, UEI/CAGE where published, activation and termination dates. Refreshed daily from the public extract (US public domain).

## What people use it for
- **Supplier due diligence and award-eligibility checks** for federal contractors, grantees and healthcare organisations.
- **KYB vendors** — bulk pulls by agency or date.

## Output (one item per exclusion)
`name, classification, exclusion_type, exclusion_program, excluding_agency, excluding_agency_name, uei_sam, cage_code, activation_date, termination_date, termination_type`

Addresses, SSN/TIN/NPI identifiers and free-text comments are dropped. Use for compliance, due-diligence, research or journalism; verify matches on SAM.gov before acting. Pay per result. Data from gankdat.com.

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the exclusion records added, removed or changed in the register since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` (`added`, `removed` or `changed`) and `changed_at` next to the record's fields. Your filters still apply, so one scheduled run is a watch — **Schedules → daily** on this actor — and you pay only for the rows that changed, typically a few dozen instead of the whole register. Nobody else sells this feed: it is computed from the official extract every day.
