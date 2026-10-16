# UK Public Tenders (Find a Tender)

The latest UK public-sector procurement notices from the official Find a Tender OCDS feed, flattened to one row per notice: OCID, notice id, title, description, **buyer**, status, procurement method, category, **CPV codes**, **value and currency**, published date and **deadline**. Refreshed daily (Open Government Licence v3).

## What people use it for
- **Bid intelligence** — new opportunities by buyer, CPV code, value band or deadline for bid teams and consultancies.
- **Market research** — who buys what, at what value.

## Output (one item per notice)
`ocid, notice_id, title, description, buyer, status, procurement_method, category, cpv_codes, value_amount, value_currency, published_at, deadline_at`

Organisation-level data only. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server; EU notices in a companion actor).
