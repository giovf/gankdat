import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

// pool-workers 0.18 has no isolated per-test storage: one workerd runtime and one
// set of D1/KV stores serve every test file in turn, so each test needs a clean
// slate. Until 2026-10-06 that was reset() (drops every store behind D1 and KV)
// plus a re-apply of all migrations before EACH test — 697 s of setup for 74 s of
// tests (foundry `gankdat-test-setup`). Now the schema is migrated once per file
// (applyD1Migrations only applies what is missing, so every file after the first
// pays one SELECT) and each test starts by emptying the tables and both KV
// namespaces instead, which keeps the schema and costs one D1 batch.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await Promise.all([emptyD1(env.DB), emptyKv(env.CACHE), emptyKv(env.RATE)]);
});

/** Deletes every row of every user table (not the migrations ledger; D1 refuses writes to its sqlite_* and _cf_* tables). */
async function emptyD1(db: D1Database): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name <> 'd1_migrations' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string; sql: string }>();
  if (results.length === 0) return;
  // Foreign keys are enforced and D1 refuses PRAGMAs in a batch, so tables that reference
  // another (REFERENCES in their DDL) are emptied before the tables they point at.
  const children = results.filter((row) => /REFERENCES/i.test(row.sql));
  const parents = results.filter((row) => !/REFERENCES/i.test(row.sql));
  await db.batch([...children, ...parents].map((row) => db.prepare(`DELETE FROM "${row.name}"`)));
}

/** Deletes every key of a KV namespace. */
async function emptyKv(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}
