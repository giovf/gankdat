# UK Businesses Without a Website

Organisations on **official UK registers that list no website** — the prospect list for web
agencies, freelancers and SaaS site builders. Three registers, one row shape, filter by sector
and area:

| Sector | Register | Coverage | Area filters |
| --- | --- | --- | --- |
| `care` | CQC care directory (weekly) | every regulated care location in England: care homes, GPs, dentists, homecare, hospices | region, local authority, outward code |
| `charity` | Charity Commission register (daily) | registered charities in England & Wales; default income ≥ £25,000 so the list is organisations that can afford a site | outward code |
| `school` | DfE Get Information About Schools (daily) | open schools, academies, colleges and nurseries in England | region, local authority, outward code |

Each row: `sector`, `name`, `organisation_type`, `address`, `postcode`, `outward_code`,
`local_authority`, `region`, `size_hint` (pupils / income / provider), `registered_since`,
`source_dataset`, `source_id` and a `source_url` back to the official register entry.

## What you get, what you don't

Organisation-level data only. The registers' named contacts, phone numbers and email addresses
are never ingested by the API behind this actor (Blind Mode), so nothing here is personal data.
Use the row to research the organisation and contact it through its published channels. Cold
outreach to UK organisations is your responsibility under PECR/UK GDPR.

## Pricing

Pay per result. Set a maximum total charge on the run; the actor stops cleanly when it is
reached. The same data is available as an API and MCP server at https://gankdat.com.

## Sources and licences

CQC (OGL v3), Charity Commission (OGL v3), Department for Education GIAS (OGL v3). Refreshed
daily; a change feed of additions and removals is available on gankdat.com.
