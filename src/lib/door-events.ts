// The door, event by event (gankdat `mcp-buy-attempt-read-2026-11-16`, 2026-11-18). The Daily
// numbers row counts the keyless calls to the protected tools (`wanted:`), the sign-up tool and
// every leg of the OAuth hop (`oauth funnel 7d:`), but a count cannot say whether one client walked
// from the 401 to the sign-in page or three crawlers each touched one step. Workers Logs cannot
// say either: eight `worker logs` reads on 2026-11-18 returned 140 of roughly 12,000 POST /mcp
// requests and none of the three sign-in page loads the funnel had counted. The Analytics Engine
// points hold every one for three months, so the `probe: true` dispatch of the metrics job prints
// them in time order (scripts/error-lines.mjs): when, which step, the user agent, the tool or the
// OAuth client host, and the hashed preview client id where the point carries one. Pure: no I/O.

/** Days the reading looks back by default (`--door-days=`), and the most it will take. */
export const DOOR_DAYS = 7;
export const DOOR_DAYS_MAX = 90;

export interface DoorRow {
  ts: string;
  kind: string;
  ua: string | null;
  /** mcp points: the methods; funnel points: the step. */
  step: string | null;
  /** mcp points: the reason (protected_tool, …) or the tool list; funnel points: the client host. */
  who: string | null;
  /** mcp points: the tool names; funnel points: the detail. */
  detail: string | null;
  /** The hashed preview client id (mcp points written since 2026-10-11), else empty. */
  client: string | null;
}

/**
 * One Analytics Engine query for the three kinds of point: a keyless call to a protected tool
 * (connect_account, buy_credits, confirm_credit_purchase), a keyless call to the sign-up tools,
 * and every OAuth leg except the token refreshes (our own connector's hourly traffic).
 */
export function doorEventsQuery(days: number): string {
  const d = Math.max(1, Math.min(DOOR_DAYS_MAX, Math.round(days) || DOOR_DAYS));
  return (
    'SELECT timestamp AS ts, blob1 AS kind, blob2 AS ua, blob3 AS step, blob4 AS who, blob5 AS detail, blob6 AS client ' +
    'FROM gankdat_traffic ' +
    `WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND (` +
    "(blob1 = 'mcp_denied' AND blob4 = 'protected_tool') " +
    "OR (blob1 = 'mcp_anon' AND (blob5 LIKE '%request_api_key%' OR blob5 LIKE '%claim_api_key%')) " +
    "OR (blob1 = 'oauth_funnel' AND blob5 != 'refresh_token')" +
    ') ORDER BY timestamp ASC LIMIT 1000'
  );
}

const clean = (text: string | null, max: number): string =>
  (text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, max);

/** `2026-11-16 04:12:09 | mcp_denied | buy_credits | protected_tool | <ua> | client 1a2b3c4d`. */
export function doorEventLine(row: DoorRow): string {
  const client = clean(row.client, 64);
  const parts =
    row.kind === 'oauth_funnel'
      ? [row.ts, 'oauth', clean(row.step, 40), clean(row.who, 80) || '(no client)']
      : [row.ts, row.kind, clean(row.detail, 80) || clean(row.step, 40), clean(row.who, 40)];
  if (row.kind === 'oauth_funnel' && clean(row.detail, 120)) parts.push(clean(row.detail, 120));
  parts.push(clean(row.ua, 120) || '(no UA)');
  if (client) parts.push(`client ${client.slice(0, 8)}`);
  return parts.join(' | ');
}

/** The reading as lines for the job log: a head line, then one line per point, oldest first. */
export function doorEventsReport(rows: DoorRow[], days: number): string[] {
  if (rows.length === 0) return [`door events ${days}d: none`];
  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  return [
    `door events ${days}d: ${rows.length} point(s), oldest first`,
    ...sorted.map((r) => `  ${doorEventLine(r)}`),
  ];
}
