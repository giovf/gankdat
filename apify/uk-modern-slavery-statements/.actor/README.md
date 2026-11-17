# UK Modern Slavery Statements Registry (by Company Number)

**Has this supplier published a modern slavery statement?** Statement summaries from the UK government's modern slavery statement registry (Home Office, Open Government Licence v3), refreshed daily. One item per organisation covered by a statement:

- **who and when** — organisation, Companies House number, registry year, statement period, approval and last-updated dates.
- **group statements** — whether the statement covers a group and, on a member's row, the parent that submitted it.
- **size and sector** — turnover band, the sectors the organisation ticked, how long it has produced statements.
- **what the statement covers** — organisation structure, policies, risk assessment, due diligence, training, goals (yes/no each), plus the policy, training, social-audit and grievance-mechanism tick-boxes.
- **links** — the statement on the organisation's own site, the registry summary page and the registry's PDF copy.

## What people use it for
- **Supplier onboarding and tender checks** — look a supplier up by company number and see every year it has a statement on the registry (UK public tenders ask for one).
- **ESG screening** — statements by turnover band, sector, or what they do and do not cover.
- **Change monitoring** — each new or updated statement summary (gankdat's daily change feed).

## Read this before you draw a conclusion
The registry is **voluntary**. Section 54 of the Modern Slavery Act 2015 requires organisations with a turnover of £36m or more to publish a statement on their own website; adding it to the registry is encouraged, not required. A company with no row here has not thereby failed to comply.

## Output (one item per organisation and statement)
`statement_id, statement_year, organisation, sector_type, company_number, group_submission, parent_name, period_start, period_end, approved_on, last_updated, turnover_band, sectors, years_producing_statements, includes_org_structure, includes_policies, includes_risk_assessment, includes_due_diligence, includes_training, includes_goals, policies, training, social_audits, grievance_mechanisms, statement_url, summary_url, registry_pdf_url`

## Data posture
Public government register, organisation level. The name and job title of the person who approved the statement, contact emails, addresses and every free-text answer (reasons, risk narratives) are never ingested. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server, daily change feeds); the latest statement also rides gankdat's Companies House company lookup as `esg.modern_slavery`.

## Monitor it (changes mode)
Set **Mode** to *Changes since a date (monitor)* and the run returns only the statement summaries added or changed since **Changes since** (default: the last 7 days; the feed keeps 90), each item carrying `change` and `changed_at`. Your filters still apply, so one scheduled daily run is a watch on your supplier list, and you pay only for what changed.
