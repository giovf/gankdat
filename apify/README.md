# Apify actors (gankdat data on the Apify Store)

One folder per actor; each is self-contained (`src/gankdat.mjs` is the shared client, copied).
They call gankdat's API with the internal service key (`GANKDAT_INTERNAL_API_KEY` in
`../.env`, account apify@gankdat.com, plan scale) and charge one pay-per-event `result` per
record. Pricing is set in the Apify Console per actor (event `result`); owner action 014 covers
the account. Publish: `cd <actor> && npx apify-cli push` with `APIFY_TOKEN` set. Local run:
`GANKDAT_API_KEY=… APIFY_LOCAL_STORAGE_DIR=./storage node src/main.mjs` with
`storage/key_value_stores/default/INPUT.json`.

**Changes mode** (2026-10-05): the nine actors whose source has a change feed (a stable record id —
`hasChangeFeed` in the registry) take `mode` (`data` | `changes`), `since` (YYYY-MM-DD, default
7 days back) and `change` (added | removed | changed) and then read `/v1/changes/<slug>` with
the same filters, pushing each change as the record plus `change` and `changed_at` — a scheduled
daily run is a register monitor, and the README's "Monitor it" section says so. The other seven
sources have no feed (the API answers 404), so their inputs do not offer the mode.

**Lookup actors** (2026-10-07): `uk-company-profiles` is an on-demand dataset (one record per
request, named by `company_number` or `company`), so its actor takes the buyer's own list
(`companies`, numbers or names) and calls the API once per entry (`runLookupActor` in the shared
client). Its `mode: changes` is a **monitor**: the previous run's records live in the actor's named
key-value store `gankdat-uk-company-profiles-baseline`, and a run pushes only companies that are new
to the list (`added`), differ from the baseline (`changed` + `changed_fields`) or vanished from the
register (`removed`) — the thing none of the thirteen Companies House actors on the Store sells
(exchange 2026-W41).

Each actor's `.actor/dataset_schema.json` (Apify validates every pushed item against it) and
`.actor/input_schema.json` (every field is sent as an API query param) must match the source's
zod `recordSchema` / `queryParams`: `test/apify-schemas.spec.ts` checks both for every folder, that the feed inputs and fields appear
exactly on the feed-bearing actors, that `src/gankdat.mjs` is identical in every single-source folder
(the merged `uk-no-website-leads` keeps its own client — the 2026-10-07 rollout copied the shared one over it
and every run died at import until 2026-10-11), and that every name a `main.mjs` imports exists in its folder's client.
A type that drifts fails every run — `uk-planning-applications` was flagged "under maintenance"
by Apify QA on 2026-09-25 because `authority` was declared a string and served as a number.

## Published actors (account `faceless-api`, 2026-09-20)

| Folder | Actor id | Console |
| --- | --- | --- |
| `uk-food-hygiene` | `F0sVyC6l1GLZ8gZvY` | https://console.apify.com/actors/F0sVyC6l1GLZ8gZvY |
| `uk-charities` | `JmaI2pSRjFJN0TaWz` | https://console.apify.com/actors/JmaI2pSRjFJN0TaWz |
| `uk-care-locations` | `YMrXK9Chuuw0zI1oF` | https://console.apify.com/actors/YMrXK9Chuuw0zI1oF |
| `uk-sponsors` | `f5B9jFHoADfZIwcKd` | https://console.apify.com/actors/f5B9jFHoADfZIwcKd |
| `uk-companies` | `GtHwSKC3Do5XYCjiR` | https://console.apify.com/actors/GtHwSKC3Do5XYCjiR |
| `uk-contract-awards` | see console (pushed 2026-09-21) | https://console.apify.com/actors |
| `uk-schools` | `JpzvkJcNfbaieyqrg` | https://console.apify.com/actors/JpzvkJcNfbaieyqrg |
| `nhs-ods` | pushed by CI on the 2026-09-22 commit | https://console.apify.com/actors |
| `uk-trademark-journal` | pushed by CI on the 2026-09-23 commit | https://console.apify.com/actors |
| `uk-gambling-operators` | pushed by CI on the 2026-09-24 commit | https://console.apify.com/actors |
| `uk-no-website-leads` | pushed by CI on the 2026-09-21 commit (merged feed: care + charities + schools with `website_present=false`) | https://console.apify.com/actors |
| `uk-company-profiles` | pushed by CI on the 2026-10-07 commit (`uk-companies-house-lookup-monitor`: lookup + monitor over the buyer's list) | https://console.apify.com/actors |

Pricing (`result` event) and Store publication are set through the API once payout billing
info exists on the account (Apify refuses monetisation without it — action 014 step 4).
