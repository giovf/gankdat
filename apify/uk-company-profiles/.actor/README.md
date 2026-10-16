# UK Companies House Lookup & Monitor

Give it **your list of UK companies** — Companies House numbers or names, one per line — and get one record per company from the **official Companies House API** (no scraping): name and number, status and status detail, type, jurisdiction, SIC codes, incorporation and dissolution dates, previous names, registered-office area, **accounts** (type, last period end, next due, overdue flag), **confirmation statement** (last made up to, next due, overdue flag), insolvency and liquidation flags, **charges** (totals plus the latest 25 with status and dates), the **latest 25 filing events** (date, category, form type, description code) and **corporate persons with significant control** with their natures of control.

## Monitor it

Set **Mode** to *Monitor* and schedule the run (daily is plenty — the register updates overnight). The previous run's records are the baseline, kept in this actor's key-value store, so each run returns **only the companies that changed**: new to your list (`change: added`), changed on the register (`change: changed`, with `changed_fields` naming what moved — `status`, `accounts_overdue`, `charges_outstanding`, `filings_total`, `corporate_controllers`, …) or gone from the register (`change: removed`). Unchanged companies push nothing and cost nothing. Pipe the dataset to Slack, email, Sheets or a webhook with any Apify integration.

## What people use it for
- **Credit control and supplier onboarding** — accounts or confirmation statement overdue, new charges, status moving to "liquidation" or a strike-off gazette filing.
- **KYB refresh** — re-check a client book monthly for status, SIC and controller changes.
- **Portfolio watch** — competitors, customers or investees: new filings and charges as they land.

## Output (one item per company)
`company_number, company, status, status_detail, company_type, subtype, jurisdiction, incorporated_on, dissolved_on, sic_codes, previous_names, locality, region, postal_code, country, registered_office_in_dispute, accounts_type, accounts_last_period_end, accounts_next_due, accounts_overdue, confirmation_last_made_up_to, confirmation_next_due, confirmation_overdue, has_charges, has_insolvency_history, has_been_liquidated, charges_total, charges_outstanding, charges_satisfied, charges[], filings_total, filings[], controllers_active, controllers_ceased, individual_controllers, corporate_controllers[], company_url` — plus `change`, `changed_at` and `changed_fields` in Monitor mode.

Organisation-level data only: officers and individual PSCs are never included (filing events carry the form and description code, e.g. `AP01` / `appoint-person-director-company-with-name-date`, not the person's name), charge holders are omitted and registered-office street lines are dropped. Crown copyright — attribute Companies House if you republish. Pay per result; set **Maximum results** to control spend. Data from gankdat.com.
