#!/usr/bin/env node
// Agentic-commerce walkthrough for the PayPal AI Hackathon entry (2026-10-11):
// the exact calls an agent makes to buy gankdat credits with PayPal (sandbox)
// and spend them, run from a terminal so a human can watch each step.
//
//   GANKDAT_API_KEY=gk_... node scripts/paypal-walkthrough.mjs [pack] [base url]
//
// 1. GET  /v1/usage                         — balance before
// 2. POST /v1/billing/paypal/orders {pack}  — PayPal order; prints the approval link
//    (approve it in a browser with a PayPal SANDBOX buyer account, then press Enter)
// 3. POST /v1/billing/paypal/orders/<id>/capture — captures, credits land on the top-up balance
// 4. GET  /v1/usage                         — balance after
// 5. GET  /v1/data/uk-sanctions?per_page=1  — one metered call; the X-Credits-* headers
//    show which balance paid (plan first, then the pack)
// Node builtins only. Sandbox only: no live money moves (src/billing/paypal.ts).

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const key = process.env.GANKDAT_API_KEY;
if (!key) {
  console.error('GANKDAT_API_KEY is required (create one at https://gankdat.com/account)');
  process.exit(1);
}
const pack = process.argv[2] ?? 'pack_1k';
const base = (process.argv[3] ?? 'https://gankdat.com').replace(/\/$/, '');
const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error)}`);
  return { json, res };
}

const step = (n, text) => console.log(`\n[${n}] ${text}`);

step(1, 'balance before');
const before = (await call('GET', '/v1/usage')).json.data;
console.log(
  `    plan ${before.plan}: ${before.used}/${before.granted} used, top-up ${before.topup}, remaining ${before.remaining}`,
);

step(2, `create a PayPal (sandbox) order for ${pack}`);
const order = (await call('POST', '/v1/billing/paypal/orders', { pack })).json.data;
console.log(`    order ${order.order_id}: ${order.credits} credits for US$${order.amount_usd}`);
console.log(`    approve it here with a sandbox buyer account:\n    ${order.approve_url}`);
const rl = createInterface({ input: stdin, output: stdout });
await rl.question('    press Enter once PayPal shows the approval… ');
rl.close();

step(3, 'capture the approved order');
const captured = (await call('POST', `/v1/billing/paypal/orders/${order.order_id}/capture`)).json
  .data;
console.log(
  `    ${captured.status}: +${captured.credits_added} credits, top-up now ${captured.topup}`,
);

step(4, 'balance after');
const after = (await call('GET', '/v1/usage')).json.data;
console.log(
  `    plan ${after.plan}: ${after.used}/${after.granted} used, top-up ${after.topup}, remaining ${after.remaining}`,
);

step(5, 'spend one credit');
const { res } = await call('GET', '/v1/data/uk-sanctions?per_page=1');
console.log(
  `    paid from: ${res.headers.get('X-Credits-Source')}; remaining on that balance: ${res.headers.get('X-Credits-Remaining')}`,
);
console.log(
  '\nDone. The same five steps are the buy_credits → confirm_credit_purchase → query_* path over MCP.',
);
