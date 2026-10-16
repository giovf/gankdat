import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

// REST adoption analytics. /mcp and /x402 have written Analytics Engine data
// points since task 52, but the REST surface wrote none at all — so STRATEGY §4's
// "change-feed calls / week" target and the proofs of `change-feed-upsell` and
// `trademark-watch-surface` were unreadable ("unknown, likely 0" in review
// 2026-W39) even while the routes were being called. Same shape as `mcp_authed`
// so `npm run traffic` and `metrics.mjs` can union the two:
//
//   blob1 kind ('rest_data' | 'rest_changes')   blob2 User-Agent
//   blob3 path                                  blob4 account id of the key (since 2026-10-11)
//   blob5 source slug
//
// UA only, never an IP (data-minimization, same rule as the MCP route). blob4 is the key's
// account id (an opaque D1 id, no email) so `datasets 30d external` in metrics.mjs can leave our
// own accounts out — the Apify actors, the probe and the owner were every call on every register
// (gankdat `metrics-dataset-queries-external`, 2026-10-11).
// Fire-and-forget after the handler: a write failure must never fail a paid
// request, and Analytics Engine writes do not add request-path latency.
export function restTraffic(kind: 'rest_data' | 'rest_changes'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    // Only count requests the caller actually got data from; 401/429/402 are
    // already visible as denials elsewhere and would inflate the adoption number.
    if (!c.res.ok) return;
    try {
      c.env.TRAFFIC.writeDataPoint({
        blobs: [
          kind,
          c.req.header('User-Agent') ?? '',
          c.req.path,
          c.get('keyCtx')?.accountId ?? '',
          c.req.param('source') ?? '',
        ],
        doubles: [1],
        indexes: [kind],
      });
    } catch {
      // Analytics is never worth a 500 on a metered request.
    }
  };
}
