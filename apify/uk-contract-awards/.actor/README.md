# UK Contract Awards (Contracts Finder) — who won what

UK public-sector **contract award notices** from the official Contracts Finder OCDS feed, flattened to **one row per award and supplier**: buyer, **winning supplier and its Companies House number**, award value and currency, award date, contract start/end, CPV codes, category and procurement method. Rolling window of the last two weeks of awards, refreshed daily (Open Government Licence v3, declared in every source response).

## What people use it for
- **Sales intelligence** — which suppliers win with which buyers, contract expiries to chase.
- **Bid intelligence and competitor tracking** by CPV code or buyer.
- **Supplier due diligence** — company numbers join straight to Companies House.

## Output (one item per award × supplier)
`ocid, notice_id, award_id, title, description, buyer, buyer_id, supplier, supplier_id, supplier_company_number, award_status, award_value_amount, award_value_currency, award_date, contract_start, contract_end, cpv_codes, category, procurement_method, published_at`

Organisation-level data only: contact persons, emails and phones in the source notices are never included. Pay per result; set **Maximum results** to control spend. Data from gankdat.com (REST API, MCP server; open opportunities in the companion Find a Tender actor).
