# gankdat
UK and EU public registers as clean JSON: company lookup and monitoring, tenders and contract awards, sanctions and exclusions, charities, schools, NHS organisations, care locations, trade marks and licences. One schema across every dataset, from official open-data feeds, with a daily change feed on each register. Connect with the key from your gankdat account.

## Publisher: gankdat

## Prerequisites
- An account at https://gankdat.com/account (sign-in by email, no password). The free plan carries 250 credits a month; paid plans and one-off credit packs are sold on gankdat.com.
- An API key from that account. The connection takes it as `Bearer yourKey`.

## Supported Operations
Every dataset has one query action; every register dataset also has a change-feed action that returns what was added, removed or changed since a date. Each action returns `ok`, `data` (the records) and `meta` (page, total, last refresh).

| Dataset | Action | Change feed |
| --- | --- | --- |
| UK planning applications | `query_uk_planning` | — |
| UK procurement notices | `query_uk_tenders` | — |
| UK contract awards (Contracts Finder) | `query_uk_contract_awards` | — |
| UK sanctions designations | `query_uk_sanctions` | — |
| EU procurement notices (TED) | `query_eu_ted` | — |
| US federal exclusions (SAM.gov) | `query_sam_exclusions` | `changes_sam_exclusions` |
| UK corporate insolvency notices | `query_uk_insolvency` | — |
| UK new company incorporations | `query_uk_companies` | — |
| UK food hygiene ratings (FSA) | `query_uk_food_hygiene` | `changes_uk_food_hygiene` |
| UK licensed visa sponsors (Home Office) | `query_uk_sponsors` | `changes_uk_sponsors` |
| Charities in England & Wales (Charity Commission) | `query_uk_charities` | `changes_uk_charities` |
| Regulated care locations in England (CQC) | `query_uk_care_locations` | `changes_uk_care_locations` |
| Schools and colleges in England (GIAS + Ofsted) | `query_uk_schools` | `changes_uk_schools` |
| NHS organisations in England (ODS register) | `query_nhs_ods` | `changes_nhs_ods` |
| UK trade mark applications published for opposition (Trade Marks Journal) | `query_uk_trademark_journal` | `changes_uk_trademark_journal` |
| Licensed gambling operators in Great Britain (Gambling Commission register) | `query_uk_gambling_operators` | `changes_uk_gambling_operators` |
| UK company lookup (Companies House) | `query_uk_company_profiles` | — |

### UK planning applications
uk feed, normalized to one schema. Blind Mode: no applicant personal data. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK procurement notices
Public procurement notices from the official Find a Tender OCDS feed, flattened to one queryable schema. Blind Mode: no contact or personal data. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK contract awards (Contracts Finder)
Who won which UK public-sector contract, for how much: award notices from the official Contracts Finder OCDS feed flattened to one row per award and supplier — buyer, supplier and its company number, award value and date, contract period, CPV codes, category and procurement method. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK sanctions designations
Every designation on the official UK Sanctions List (FCDO) — individuals, entities, and ships, with regimes, aliases, and dates — normalized for supplier due diligence. Served as published by government for compliance purposes; dates of birth, identity documents, and contact details are dropped at ingest. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### EU procurement notices (TED)
Contract notices and awards from TED (Tenders Electronic Daily), the official EU procurement journal — buyer, country, CPV codes, values, and deadlines across all member states, normalized for bid intelligence. Blind Mode: only organisation-level fields are ingested. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### US federal exclusions (SAM gov)
gov list — individuals, firms, special entities, and vessels barred from federal awards, with agency, program, and dates — normalized for supplier due diligence. Served as published by the US government for compliance purposes; all addresses, identifiers (SSN/TIN/NPI), and free-text comments are dropped at ingest. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK corporate insolvency notices
The latest corporate insolvency notices from The Gazette (official UK public record) — winding-up petitions and orders, administrator, receiver and liquidator appointments, moratoria, and creditor notices, company-level facts only. Blind Mode: person fields and notice text in the source are never ingested. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK new company incorporations
The newest companies on the UK register, from the official Companies House API — name, number, type, SIC codes, incorporation date, and registered-office area, refreshed daily. Blind Mode: company-level fields only; officer and PSC data are never ingested, and address lines are dropped in favour of locality/postcode. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK food hygiene ratings (FSA)
Records from UK food hygiene ratings (FSA). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK licensed visa sponsors (Home Office)
Every organisation on the Home Office register of licensed sponsors for Worker and Temporary Worker visa routes — organisation name, town and county, sponsor type, licence rating, and the immigration route (Skilled Worker, Global Business Mobility, Creative Worker, and more). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### Charities in England and Wales (Charity Commission)
Records from Charities in England & Wales (Charity Commission). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### Regulated care locations in England (CQC)
Every health and social care location regulated by the Care Quality Commission in England — hospitals, care homes, GP practices, dentists, homecare agencies, hospices, ambulance services — with service types, specialisms, provider, address and area, local authority, region, and the date of the latest CQC check. One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### Schools and colleges in England (GIAS Ofsted)
Records from Schools and colleges in England (GIAS + Ofsted). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### NHS organisations in England (ODS register)
Records from NHS organisations in England (ODS register). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK trade mark applications published for opposition (Trade Marks Journal)
Records from UK trade mark applications published for opposition (Trade Marks Journal). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### Licensed gambling operators in Great Britain (Gambling Commission register)
Records from Licensed gambling operators in Great Britain (Gambling Commission register). One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.

### UK company lookup (Companies House)
One UK company by number or name, live from the official Companies House API: profile, status, type, SIC codes, registered-office area, accounts and confirmation-statement dates and overdue flags, charges, the latest filing events and corporate persons with significant control. Blind Mode: officers and individual PSCs are never ingested — filing events carry the category code, not the name. Cached 24 h. One call returns the one record named by the lookup key and costs one credit.

### US federal exclusions (SAM gov) changes
Rows added, removed or changed in US federal exclusions (SAM.gov) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### UK food hygiene ratings (FSA) changes
Rows added, removed or changed in UK food hygiene ratings (FSA) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### UK licensed visa sponsors (Home Office) changes
Rows added, removed or changed in UK licensed visa sponsors (Home Office) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### Charities in England and Wales (Charity Commission) changes
Rows added, removed or changed in Charities in England & Wales (Charity Commission) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### Regulated care locations in England (CQC) changes
Rows added, removed or changed in Regulated care locations in England (CQC) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### Schools and colleges in England (GIAS Ofsted) changes
Rows added, removed or changed in Schools and colleges in England (GIAS + Ofsted) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### NHS organisations in England (ODS register) changes
Rows added, removed or changed in NHS organisations in England (ODS register) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### UK trade mark applications published for opposition (Trade Marks Journal)
Rows added, removed or changed in UK trade mark applications published for opposition (Trade Marks Journal) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### Licensed gambling operators in Great Britain (Gambling Commission register)
Rows added, removed or changed in Licensed gambling operators in Great Britain (Gambling Commission register) between daily refreshes, newest first, with 90 days of history. Poll this instead of re-reading the whole register; the same filters as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.

### List datasets
Lists every dataset with its filters, refresh schedule, credit cost per call and whether it carries a change feed.

### Get credit usage
Reads the credits used and remaining this period for the connected key. This call is free.

## Obtaining Credentials
1. Sign in at https://gankdat.com/account with your email address.
2. Create an API key on the account page and copy it.
3. When the connector asks for the connection, enter the key as `Bearer yourKey` (the word Bearer, a space, then the key).

## Known Issues and Limitations
- One query costs the credits the dataset lists (one by default); a key over its monthly allowance receives a 402 until the period resets or credits are bought.
- Queries are paged (25 records by default, 100 at most); use `page` to read further pages.
- Change feeds hold 90 days of history and are only offered for register datasets (the table above).
- The keyless preview that gankdat offers to AI agents is not available through this connector: a connection always carries a key.

## Deployment Instructions
The package is generated from the API's own schema registry (`npm run connector` in the gankdat repository) — do not edit the Swagger by hand. To deploy it as a custom connector in your own environment, use the [paconn](https://learn.microsoft.com/connectors/custom-connectors/paconn-cli) CLI:

```
paconn login
paconn create --api-prop apiProperties.json --api-def apiDefinition.swagger.json --icon icon.png
```

## Frequently Asked Questions
### Where does the data come from?
Official open-data publications of the UK and EU registers named in each dataset's description; the licence and personal-data posture of each is stated at https://gankdat.com/terms.

### How fresh is it?
Register datasets refresh every night; the `last_refreshed_at` field in `meta` says when. The company lookup reads the register on demand.
