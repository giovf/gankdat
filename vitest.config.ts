import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ADMIN_TOKEN: 'test-admin-token',
          STRIPE_SECRET_KEY: 'sk_test_dummy',
          STRIPE_WEBHOOK_SECRET: 'whsec_testsecret',
          // PayPal sandbox (credit packs): tests stub api-m.sandbox.paypal.com.
          PAYPAL_SANDBOX_CLIENT_ID: 'test-paypal-client',
          PAYPAL_SANDBOX_SECRET: 'test-paypal-secret',
          RESEND_API_KEY: 're_test_dummy',
          // Data-source API keys: tests stub the HTTP layer, so the VALUE is
          // irrelevant — but it must be present, else the source bails to
          // fixture fallback (which serves different data than the test stubs).
          // Set here rather than relying on .dev.vars, which CI doesn't have.
          SAM_API_KEY: 'test-sam-key',
          COMPANIES_HOUSE_API_KEY: 'test-ch-key',
          FIXTURE_FALLBACK: 'true',
        },
      },
    }),
  ],
  test: {
    // Pre-bundle the heavy dependencies once per run (foundry gankdat-test-setup, 2026-10-06):
    // every test file loads the whole Worker graph afresh, and before this it fetched ~2,600
    // modules through Vite per file (viem 1,194, stripe 191, zod 126, ox 102 …) — 17 s of setup
    // per file, 261 s for the suite on 4 cores. Bundled, a file loads ~250 modules; with the x402
    // packages imported lazily (src/x402/routes.ts) the suite ran in 80 s on the same sandbox.
    // 2026-10-14: the lane moved to the x402 v2 packages (@x402/*); the same lazy rule applies.
    // Only packages with a root export, or explicit subpaths, can be listed.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          // Node built-ins stay external: workerd's module fallback resolves them at run time.
          rolldownOptions: { external: [/^node:/, ...builtinModules] },
          include: [
            '@x402/hono',
            '@x402/core/server',
            '@x402/evm/exact/server',
            '@x402/extensions/bazaar',
            '@coinbase/x402',
            'viem',
            'ox',
            'stripe',
            'zod',
            'hono',
            '@hono/mcp',
            '@modelcontextprotocol/sdk/server/mcp.js',
            'jose',
            'axios',
            'abitype',
            'zod-to-json-schema',
            '@coinbase/cdp-sdk',
          ],
        },
      },
    },
    setupFiles: ['./test/apply-migrations.ts'],
    // Slow shared runners: two uk-trademark-journal cases (1.5 s locally) hit vitest's 5 s
    // default on 2026-09-30 (check run 118, same tree green on the re-run). A CI red from
    // timing is noise the routines then chase; the workers pool is slow to spin, not the code.
    testTimeout: 20_000,
  },
});
