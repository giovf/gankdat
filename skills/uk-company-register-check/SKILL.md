---
name: uk-company-register-check
description: Check a list of UK companies against five official registers through the gankdat API (Companies House record, Charity Commission, Gazette insolvency notices, the UK sanctions list, licensed visa sponsors) and return a qualification digest — status, overdue filings, insolvency and sanctions flags, charity and sponsor-licence tags — with a coverage and spend line. Use before outbound or onboarding to route, review or disqualify accounts; optionally push the rows into a Clay table. Not a contact finder (no officers or personal data).
---

# UK company register check

## When to use it

Use this Skill when you have a list of UK companies (names, Companies House numbers or both) and
want to know, from the official registers, which are safe to approach and which to drop: is the
company active, are its accounts or confirmation statement overdue, does it have charges or an
insolvency history, has The Gazette published an insolvency notice against it, is the name on the
UK Sanctions List, is it a registered charity, does it hold a visa sponsor licence. Do not use it
to find directors, owners or contacts: the API drops personal data at ingest and returns none.

## Inputs

1. **Companies** — a CSV path, a pasted list or a Clay table export. Columns used:
   `company_number` (preferred; keep leading zeros) and/or `company_name`.
2. **Rules** — which outcomes mean _disqualify_, _review_ and _qualified_ (defaults below), and
   which tags matter (charity, sponsor licence).
3. **Budget** — the maximum gankdat credits this run may spend. One call is one credit; a full
   check is up to five calls per company (two when only the Companies House record is wanted).
4. **Delivery** — a table in the conversation, a CSV path, or rows pushed into a Clay table.

## Setup

- A gankdat API key, free for 250 calls a month (`https://gankdat.com/account`, email sign-in;
  paid plans from £5 per 1,000). Read it from the `GANKDAT_API_KEY` environment variable; if it is
  not set, ask the user to export it in their shell — never paste a key into the conversation and
  never write it into a file.
- Every call is `GET https://gankdat.com/v1/data/<source>?<param>=<value>` with the header
  `Authorization: Bearer $GANKDAT_API_KEY` and answers
  `{ "ok": true, "data": [ …records ], "meta": { "total": N, "page": 1, "per_page": … } }`; an
  error is `{ "ok": false, "error": { "code", "message" } }` with the HTTP status (400 names the
  valid parameters, 401 a bad key, 402 credits spent, 429 the per-minute limit with
  `Retry-After`, 503 a busy register — retry once after the header's seconds).
- Rate limits: `uk-company-profiles` 30 calls a minute per account; the other sources 60. Pace the
  loop accordingly (a 2-second gap for the company record, 1 second otherwise).

## Workflow

1. **Confirm scope and cost before any call.** De-duplicate the list, count the companies with a
   number and those with a name only, state the calls the run will make (names: one extra call
   each to resolve the number), the credits that is, and the user's budget. Stop if the plan
   exceeds the budget; propose the Companies-House-only variant (one credit a company) instead.
2. **Resolve numbers.** For a name-only row,
   `GET /v1/data/uk-company-profiles?company=<name>` returns the register's top search hit; keep
   `data[0].company_number` and `data[0].company`, and mark the row `resolved-by-name` so the
   user knows the match was the register's, not theirs. An empty `data` is `not-found`.
3. **Company record.** `GET /v1/data/uk-company-profiles?company_number=<number>`. Read `status`,
   `status_detail`, `incorporated_on`, `sic_codes`, `accounts_overdue`, `confirmation_overdue`,
   `has_charges`, `has_insolvency_history`, `has_been_liquidated`, `postal_code`, `company_url`.
   Use the record's own `company` (the registered name) for steps 4–6.
4. **Insolvency notices.** `GET /v1/data/uk-insolvency?company=<registered name>` — `meta.total`
   notices in the served window; keep the first notice's `notice_type`, `published_at` and
   `notice_url`. The match is a case-insensitive substring: when the name is one common word,
   read the hits and keep only those naming this company.
5. **Sanctions.** `GET /v1/data/uk-sanctions?name=<registered name>` — `meta.total` designations
   whose name contains the text, with `regime` and `date_designated`. Treat a hit as _review_,
   never as a verdict: a substring over-matches common words and under-matches transliterated
   aliases, and this is a screening aid, not legal advice.
6. **Charity and sponsor licence.** `GET /v1/data/uk-charities?company_number=<number>`
   (`meta.total` > 0 means a registered charity; `registered_charity_number`,
   `registration_status`, `latest_income`) and
   `GET /v1/data/uk-sponsors?organisation=<registered name>` (`meta.total` > 0 means a licence;
   `route`, `rating`, `town` — one row per organisation × town × route).
7. **Place every company.** Default rules, unless the user changed them in step 1:
   - _disqualify_ — `status` is not `active`, or sanctions `meta.total` > 0 after reading the
     hits, or insolvency `meta.total` > 0;
   - _review_ — `accounts_overdue` or `confirmation_overdue` is true, or `has_insolvency_history`
     is true, or the row was `resolved-by-name` and the registered name differs materially from
     the input name;
   - _qualified_ — everything else; tags `charity` and `sponsor-licence` where the totals say so.
   - _not-found_ — no register record; _unreadable_ — the API answered an error after one retry.
8. **Deliver.** The digest table (company, number, status, age in years, overdue flags,
   insolvency notices, sanctions hits, charity, sponsor licence, verdict, `company_url`) and one
   coverage-and-spend line: companies checked, placed, not found, unreadable, calls made, credits
   spent (one per 2xx call). If delivery is a Clay table, write a CSV the user imports, or POST
   each row to the table's Clay webhook URL when they give one; the Skill itself never stores the
   results anywhere else.

## Notes

- The API's full field list and every other register gankdat serves (tenders, contract awards,
  care locations, schools, NHS organisations, food hygiene, trade marks, gambling licences, EU
  TED, US exclusions) are at `https://gankdat.com/docs`; the Clay column configurations for the
  five checks above are at `https://gankdat.com/clay`.
- A company record is cached 24 hours per company number, so a re-run the same day repeats no
  Companies House read; every call is still metered as one credit, which is why step 1 counts
  them.
- Data comes from the publishers' own open feeds under their licences (`https://gankdat.com/terms`);
  no personal data is returned, so nothing here needs a lawful-basis note for people data.
