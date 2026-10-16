#!/usr/bin/env node
// Terminal dashboard for the gankdat_traffic Analytics Engine dataset:
// daily anonymous-vs-authed /mcp volume and top crawler user-agents.
//
//   npm run traffic            (loads CLOUDFLARE_API_TOKEN via --env-file=.env)
//
// Local-only by design — no deployed admin surface, no token in a browser
// (see RUNBOOK.md "Traffic analytics"). Read-only: worst case a leaked token
// with this permission reads request counts.

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44'; // not a secret
const DATASET = 'gankdat_traffic';

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN missing — run via `npm run traffic` (reads .env)');
  process.exit(1);
}

const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const AMBER = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function sql(query) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: `${query} FORMAT JSON` },
  );
  const text = await res.text();
  if (!res.ok) {
    // A dataset only exists after its first write — friendlier than a raw 4xx.
    if (/does not exist|no such table|not found/i.test(text)) return null;
    throw new Error(`SQL API ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text).data ?? [];
}

function bar(value, max, width = 30) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(filled).padEnd(width);
}

const KIND_COLOR = { mcp_anon: GREEN, mcp_authed: MAGENTA, mcp_denied: RED };
const kindColor = (kind) => KIND_COLOR[kind] ?? RESET;

const daily = await sql(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
         blob1 AS kind,
         SUM(_sample_interval * double1) AS requests
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '14' DAY
  GROUP BY day, kind
  ORDER BY day ASC
`);

if (daily === null) {
  console.log(
    `${DIM}No data yet — the dataset appears on its first /mcp request after deploy.${RESET}`,
  );
  process.exit(0);
}

console.log(
  `\n${GREEN}gankdat${RESET} /mcp traffic — last 14 days  ${DIM}(${GREEN}█${RESET}${DIM} anon · ${MAGENTA}█${RESET}${DIM} authed · ${RED}█${RESET}${DIM} denied 401)${RESET}\n`,
);

const byDay = new Map();
for (const row of daily) {
  const day = String(row.day).slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, {});
  byDay.get(day)[row.kind] = Number(row.requests);
}
const dayMax = Math.max(1, ...[...byDay.values()].flatMap((k) => Object.values(k)));
for (const [day, kinds] of byDay) {
  let labelled = false;
  for (const kind of ['mcp_anon', 'mcp_authed', 'mcp_denied']) {
    if (!kinds[kind]) continue;
    const n = Math.round(kinds[kind]);
    const label = labelled ? ' '.repeat(10) : day;
    labelled = true;
    console.log(`  ${label}  ${kindColor(kind)}${bar(n, dayMax)}${RESET} ${n}`);
  }
}
if (byDay.size === 0) console.log(`  ${DIM}(no requests in window)${RESET}`);

const agents = await sql(`
  SELECT blob2 AS ua, blob1 AS kind,
         SUM(_sample_interval * double1) AS requests
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '7' DAY
  GROUP BY ua, kind
  ORDER BY requests DESC
  LIMIT 15
`);

console.log(`\ntop user-agents — last 7 days\n`);
if (!agents?.length) {
  console.log(`  ${DIM}(none yet)${RESET}`);
} else {
  const uaWidth = Math.min(60, Math.max(...agents.map((a) => (a.ua || '(none)').length)));
  const KIND_LABEL = {
    mcp_anon: `${GREEN}anon  ${RESET}`,
    mcp_authed: `${MAGENTA}authed${RESET}`,
    mcp_denied: `${RED}denied${RESET}`,
    x402_paid: `${AMBER}paid $${RESET}`,
  };
  for (const a of agents) {
    const ua = (a.ua || '(none)').slice(0, 60).padEnd(uaWidth);
    console.log(`  ${ua}  ${KIND_LABEL[a.kind] ?? a.kind}  ${Math.round(Number(a.requests))}`);
  }
}

// Method mix (blob3, recorded since task 45): splits crawler introspection
// (initialize/tools/list) from real tool usage. Rows written before the
// upgrade have an empty blob3.
const methods = await sql(`
  SELECT blob3 AS methods, blob1 AS kind,
         SUM(_sample_interval * double1) AS requests
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '7' DAY
    AND blob1 IN ('mcp_anon', 'mcp_authed')
  GROUP BY methods, kind
  ORDER BY requests DESC
  LIMIT 15
`);

console.log(`\n/mcp method mix — last 7 days\n`);
if (!methods?.length) {
  console.log(`  ${DIM}(none yet)${RESET}`);
} else {
  const nameOf = (m) => m || '(before method tracking)';
  const width = Math.max(...methods.map((m) => nameOf(m.methods).length));
  for (const m of methods) {
    const label = m.kind === 'mcp_anon' ? `${GREEN}anon  ${RESET}` : `${MAGENTA}authed${RESET}`;
    console.log(
      `  ${nameOf(m.methods).padEnd(width)}  ${label}  ${Math.round(Number(m.requests))}`,
    );
  }
}

// The conversion signal: a keyless tools/call means an agent moved past
// introspection and actually wanted the data, then stopped at the paywall.
// bad_key = someone holding a key that doesn't validate (misconfiguration).
const denied = await sql(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
         blob2 AS ua, blob3 AS methods, blob4 AS reason,
         SUM(_sample_interval * double1) AS requests
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '14' DAY AND blob1 = 'mcp_denied'
  GROUP BY day, ua, methods, reason
  ORDER BY day ASC, requests DESC
  LIMIT 40
`);

console.log(`\n${RED}denied /mcp calls (401)${RESET} — last 14 days\n`);
if (!denied?.length) {
  console.log(`  ${DIM}(none — no agent has tried a tool call without a valid key yet)${RESET}`);
} else {
  for (const d of denied) {
    const ua = (d.ua || '(none)').slice(0, 40).padEnd(40);
    const what = `${d.methods || '(malformed)'} · ${d.reason}`;
    console.log(
      `  ${String(d.day).slice(0, 10)}  ${ua}  ${what.padEnd(24)}  ${RED}${Math.round(Number(d.requests))}${RESET}`,
    );
  }
}

const payments = await sql(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
         blob3 AS path,
         SUM(_sample_interval * double1) AS payments
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob1 = 'x402_paid'
  GROUP BY day, path
  ORDER BY day ASC
`);

console.log(`\n${AMBER}x402 payments${RESET} — last 30 days\n`);
if (!payments?.length) {
  console.log(
    `  ${DIM}(none yet — settlements also visible on basescan.org at the payTo wallet)${RESET}`,
  );
} else {
  let total = 0;
  for (const p of payments) {
    const n = Math.round(Number(p.payments));
    total += n;
    console.log(`  ${String(p.day).slice(0, 10)}  ${p.path.padEnd(28)}  ${AMBER}${n}${RESET}`);
  }
  console.log(`\n  total: ${AMBER}${total}${RESET} paid request(s)`);
}
console.log();
