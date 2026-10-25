UK and EU public registers as clean JSON: company lookup and monitoring, tenders and contract awards, sanctions and exclusions, charities, schools, NHS organisations, care locations, trade marks and licences. One schema across every dataset, from official open-data feeds, with a daily change feed on each register. Connect with the key from your gankdat account.

## Prerequisites
You need a gankdat account and an API key. Sign in at https://gankdat.com/account with your email address and create a key there; the free plan carries 250 credits a month, and paid plans and credit packs are sold on the same page.

## How to get credentials
Create an API key at https://gankdat.com/account. When you create the connection, enter the key as `Bearer yourKey` — the word Bearer, a space, then the key.

## Get started with your connector
Add a gankdat action to a flow or app, pick the dataset, set the filters you need (every text filter is a case-insensitive contains, dates take YYYY-MM-DD, numbers and true/false match exactly) and read the records from `data`. To watch a register instead of re-reading it, use its changes action with `since` set to the last run.

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

## Known issues and limitations
- Each query costs the credits the dataset lists (one by default). A key over its monthly allowance receives a 402 until the period resets or credits are bought.
- Results are paged: 25 records by default, 100 at most per call.
- Change feeds hold 90 days of history and exist for register datasets only.

## Common errors and remedies
- **401** — the connection's key is missing, mistyped or revoked, or was entered without the word `Bearer`. Create a new key at https://gankdat.com/account and recreate the connection.
- **402** — the month's credits are spent. Wait for the period to reset or buy credits on the account page.
- **429** — more than the dataset's rate limit in a minute. Retry after the `Retry-After` seconds.

## FAQ
### Is personal data returned?
No. Every dataset is organisation-level; personal fields are dropped before storage, as https://gankdat.com/privacy states.

### Which plans work with the connector?
Any gankdat plan, the free one included. The connector itself is free; the store does not bill.
