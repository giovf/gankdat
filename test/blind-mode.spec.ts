import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { listSources } from '../src/sources/registry';
import type { DataSource } from '../src/sources/types';

// Blind-Mode lock (security backlog item 8, task 25). Every source promises in
// the terms licence table that personal/prohibited fields are dropped AT
// INGEST. That promise currently rests on each source's normalize() picking
// fields explicitly — one z.looseObject/.passthrough(), one `...raw` spread,
// or one new upstream field name and it leaks silently. These tests fail the
// build if that ever happens, for EVERY registered source, present and future.

// Substrings that must never appear in a served field NAME. Keep this list
// aligned with the per-dataset postures in public/terms.html.
const BANNED_FIELD_SUBSTRINGS = [
  'address_line',
  'addressline',
  'street',
  'email',
  'phone',
  'telephone',
  'contact',
  'date_of_birth',
  'dateofbirth',
  'dob',
  'passport',
  'ssn',
  'tin',
  'npi',
  'nino',
  'familyname',
  'family_name',
  'forename',
  'surname',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'officer',
  'psc',
  'birth',
];

/** The record fields a source declares — i.e. everything it may ever serve. */
function declaredFields(source: DataSource): string[] {
  const schema = source.recordSchema as unknown as { shape?: Record<string, unknown> };
  expect(schema.shape, `${source.slug}: recordSchema must be a zod object`).toBeDefined();
  return Object.keys(schema.shape!);
}

/**
 * Records as the source actually produces them. Origins are stubbed offline so
 * every source falls back to its bundled fixture (captured from the real feed),
 * which exercises the real normalize() path.
 */
async function producedRecords(source: DataSource): Promise<Record<string, unknown>[]> {
  const records = await source.fetchFresh(env);
  return records as Record<string, unknown>[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Blind Mode (every registered source)', () => {
  it.each(listSources().map((source) => [source.slug, source] as const))(
    '%s declares no personal/prohibited field names',
    (slug, source) => {
      for (const field of declaredFields(source)) {
        const normalized = field.toLowerCase();
        // Short tokens (tin, ssn, dob, npi, psc) are matched as whole
        // underscore-separated segments — "rating_value" is not a TIN.
        const segments = normalized.split('_');
        for (const banned of BANNED_FIELD_SUBSTRINGS) {
          expect(
            banned.length <= 3 ? segments.includes(banned) : normalized.includes(banned),
            `${slug}: record field "${field}" matches banned substring "${banned}" — personal data must be dropped at ingest`,
          ).toBe(false);
        }
      }
    },
  );

  it.each(listSources().map((source) => [source.slug, source] as const))(
    '%s serves only its declared fields (no passthrough leakage)',
    async (slug, source) => {
      vi.stubGlobal('fetch', () => {
        throw new Error('origins offline: use the bundled fixture');
      });
      const allowed = new Set(declaredFields(source));
      const records = await producedRecords(source);
      expect(records.length, `${slug}: fixture produced no records`).toBeGreaterThan(0);
      for (const record of records) {
        for (const field of Object.keys(record)) {
          expect(
            allowed.has(field),
            `${slug}: served undeclared field "${field}" — recordSchema is the whitelist`,
          ).toBe(true);
        }
      }
    },
  );

  it.each(listSources().map((source) => [source.slug, source] as const))(
    '%s recordSchema strips unknown fields rather than passing them through',
    (slug, source) => {
      const schema = source.recordSchema as z.ZodType<Record<string, unknown>>;
      const sample = Object.fromEntries(
        declaredFields(source).map((field) => [field, undefined]),
      ) as Record<string, unknown>;
      // A loose/passthrough schema would keep these; a strict object drops them.
      const parsed = schema.safeParse({
        ...sample,
        applicant_email: 'leak@example.com',
        date_of_birth: '1980-01-01',
      });
      if (parsed.success) {
        expect(
          Object.keys(parsed.data),
          `${slug}: schema passed through injected personal fields`,
        ).not.toContain('applicant_email');
        expect(Object.keys(parsed.data)).not.toContain('date_of_birth');
      }
    },
  );
});
