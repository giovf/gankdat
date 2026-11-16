import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Guard for new D1 migrations (foundry `ci-gankdat-failing`, 2026-11-16). CI applies migrations to
// production BEFORE it deploys, and the first form of migration 0018 failed that step twice on
// 2026-11-15, each time with the deploy skipped:
//   run 209 — `CREATE INDEX … ON source_records` walked ~1.5M wide rows and D1 reset the
//             statement at 60 s ("storage operation exceeded timeout", code 7429);
//   run 210 — `ALTER TABLE source_meta ADD COLUMN lookup_keyed` met "duplicate column name":
//             run 209's statements had committed server-side although the API call failed and
//             the migration was never recorded, so the same file could not be applied again.
// Both are properties of the SQL text, so they are refused here, where `npm run check` and CI's
// test step run before anything reaches production. Migrations up to 0017 are applied and stay.

const FIRST_GUARDED = 18;

/** Tables too large for any migration statement to walk: D1 resets a statement at 60 s. */
const BIG_TABLES = ['source_records', 'source_changes'];

/**
 * A migration that must carry a statement the guard refuses is named here with its reason, so
 * the exception is a reviewed line and never a silent pass. Empty on purpose.
 */
const EXCEPTIONS: Record<string, string> = {};

/** The statements of a migration, comments removed, whitespace collapsed. */
export function statementsOf(queries: readonly string[]): string[] {
  return queries
    .join(';\n')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

/** Why a statement is refused in a new migration, or null when it is fine. */
export function refusal(statement: string): string | null {
  const big = BIG_TABLES.find((table) => new RegExp(`\\b${table}\\b`, 'i').test(statement));
  if (big !== undefined) {
    return `touches ${big}: D1 resets a statement that walks it at 60 s — keep new data in a table of its own`;
  }
  if (/^CREATE\b/i.test(statement) && !/\bIF NOT EXISTS\b/i.test(statement)) {
    return 'CREATE without IF NOT EXISTS: cannot be applied again after a half-recorded run';
  }
  if (/^DROP\b/i.test(statement) && !/\bIF EXISTS\b/i.test(statement)) {
    return 'DROP without IF EXISTS: cannot be applied again after a half-recorded run';
  }
  if (/^ALTER\b/i.test(statement)) {
    return 'ALTER TABLE cannot be applied twice (SQLite has no ADD COLUMN IF NOT EXISTS): use a new table';
  }
  return null;
}

function numberOf(name: string): number {
  return Number.parseInt(name, 10);
}

describe('migration guard', () => {
  it('refuses the two statements that failed runs 209 and 210', () => {
    expect(
      refusal(
        'CREATE INDEX IF NOT EXISTS idx_source_records_lookup ON source_records (source_slug, lookup_key)',
      ),
    ).toMatch(/source_records/);
    expect(refusal('ALTER TABLE source_records ADD COLUMN lookup_key TEXT')).toMatch(
      /source_records/,
    );
    expect(refusal('ALTER TABLE source_meta ADD COLUMN lookup_keyed TEXT')).toMatch(/ALTER TABLE/);
    expect(refusal('CREATE TABLE source_keys (seq INTEGER)')).toMatch(/IF NOT EXISTS/);
    expect(refusal('DROP INDEX idx_source_records_lookup')).toMatch(/IF EXISTS/);
  });

  it('accepts re-runnable statements on tables of their own', () => {
    expect(refusal('DROP INDEX IF EXISTS idx_source_records_lookup')).toBeNull();
    expect(
      refusal('CREATE TABLE IF NOT EXISTS source_keys (seq INTEGER) WITHOUT ROWID'),
    ).toBeNull();
    expect(refusal('CREATE INDEX IF NOT EXISTS idx_small ON source_keys (seq)')).toBeNull();
  });

  it('strips comments before reading statements', () => {
    expect(
      statementsOf([
        '-- ALTER TABLE source_records ADD COLUMN x\nCREATE TABLE IF NOT EXISTS t (a TEXT)',
        '/* DROP TABLE t */ DROP INDEX IF EXISTS i',
      ]),
    ).toEqual(['CREATE TABLE IF NOT EXISTS t (a TEXT)', 'DROP INDEX IF EXISTS i']);
  });

  it('sees every migration, numbered without gaps', () => {
    const numbers = env.TEST_MIGRATIONS.map((migration) => numberOf(migration.name));
    expect(numbers.length).toBeGreaterThanOrEqual(FIRST_GUARDED);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('finds no refused statement in a migration from 0018 on', () => {
    const refused: string[] = [];
    for (const migration of env.TEST_MIGRATIONS) {
      if (numberOf(migration.name) < FIRST_GUARDED) continue;
      if (EXCEPTIONS[migration.name] !== undefined) continue;
      for (const statement of statementsOf(migration.queries)) {
        const why = refusal(statement);
        if (why !== null) refused.push(`${migration.name}: ${why} — ${statement.slice(0, 80)}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it('keeps every exception pointed at a real migration', () => {
    const names = new Set(env.TEST_MIGRATIONS.map((migration) => migration.name));
    for (const [name, reason] of Object.entries(EXCEPTIONS)) {
      expect(names.has(name), `${name} is not a migration`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
