#!/usr/bin/env node
// x402 test client — pays for ONE /x402 request with USDC, so you can watch the
// pay-per-request flow settle to the receiving wallet. x402 v2 (@x402/fetch) since
// 2026-10-14; the same call is the one settled payment that indexes gankdat's routes in
// the x402 Bazaar (docs/for-owner/actions/026-x402-bazaar-first-payment.md).
//
//   PRIVATE_KEY=0xYOUR_BUYER_WALLET_KEY node scripts/x402-test-client.mjs
//   X402_NETWORK=base-sepolia PRIVATE_KEY=… node scripts/x402-test-client.mjs   # testnet
//   X402_TARGET=https://gankdat.com/x402/data/uk-sanctions?per_page=1 …        # another route
//
// The BUYER wallet must be a DIFFERENT wallet from the receiving address (you can't pay
// yourself). On Base mainnet it needs about one cent of USDC; on Base Sepolia, test USDC
// from faucet.circle.com. Signing is gasless (EIP-3009): the facilitator submits the
// transaction and pays gas, so the buyer wallet needs USDC only. NEVER share the key.
//
// User agent: `gankdat-x402-probe/…` — the metrics runner counts a payment under it as
// internal (the self-paid onboarding step), never as a sale.
import { x402Client } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const NETWORKS = {
  base: { chain: base, caip2: 'eip155:8453', explorer: 'https://basescan.org' },
  'base-sepolia': {
    chain: baseSepolia,
    caip2: 'eip155:84532',
    explorer: 'https://sepolia.basescan.org',
  },
};
const networkName = process.env.X402_NETWORK || 'base';
const network = NETWORKS[networkName];
if (!network) {
  console.error(`X402_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}
const TARGET = process.env.X402_TARGET || 'https://gankdat.com/x402/data/uk-tenders?per_page=2';
const USER_AGENT = 'gankdat-x402-probe/2';

// MetaMask exports the key as 64 hex chars, usually WITHOUT the 0x prefix.
// Accept it either way (and trim stray whitespace).
const raw = (process.env.PRIVATE_KEY ?? '').trim().replace(/^0x/i, '');
if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
  console.error(
    'Set PRIVATE_KEY to your BUYER wallet key: 64 hex characters (0x optional).\n' +
      'In MetaMask: Account menu (⋮) → Account details → Show private key.\n' +
      'If you see 12/24 words, that is your Secret Recovery Phrase — do NOT use that here.',
  );
  process.exit(1);
}
const pk = `0x${raw}`;

const account = privateKeyToAccount(pk);
console.log('Buyer wallet (paying from):', account.address);
console.log('Network:', networkName, `(${network.caip2})`);
console.log('Calling:', TARGET, '\n');

const publicClient = createPublicClient({ chain: network.chain, transport: http() });
const client = registerExactEvmScheme(new x402Client(), {
  signer: toClientEvmSigner(account, publicClient),
  networks: [network.caip2],
});
const fetchWithPay = wrapFetchWithPayment(fetch, client);

try {
  const res = await fetchWithPay(TARGET, { headers: { 'User-Agent': USER_AGENT } });
  console.log('HTTP status:', res.status);
  const settlement = res.headers.get('payment-response');
  if (settlement) {
    const receipt = JSON.parse(Buffer.from(settlement, 'base64').toString('utf8'));
    console.log('Settlement receipt (PAYMENT-RESPONSE):', JSON.stringify(receipt));
    if (receipt.transaction)
      console.log('Transaction:', `${network.explorer}/tx/${receipt.transaction}`);
  }
  const body = await res.json();
  console.log('\nData received:\n', JSON.stringify(body, null, 2).slice(0, 700));
  if (res.status !== 200 || !settlement) {
    console.error('\n❌ No settlement: the response above says why (402 = payment not accepted).');
    process.exit(1);
  }
  console.log(
    `\n✅ Paid request succeeded. USDC moved from the buyer to the receiving address (${network.explorer}).`,
  );
} catch (err) {
  console.error('\n❌ Failed:', err?.message || err);
  console.error(
    'Common causes: the buyer wallet has no USDC on this network, or you used the receiving wallet as the buyer.',
  );
  process.exit(1);
}
