import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-sanctions.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// UK Sanctions List (UKSL) — the FCDO's single list of all UK sanctions
// designations since the 28 Jan 2026 consolidation (it also carries UN
// designations the UK implements). Stable static URL, OGL v3.
//
// The published CSV is one row per NAME (aliases, script variants) — ~58
// columns × ~58k rows ≈ 49 MB for ~6.3k designations — so ingest streams the
// body through an RFC-4180 parser and groups rows by Unique ID instead of
// buffering the file.
//
// Data minimization (per-dataset terms, task 38): this dataset inherently
// consists of personal data published by government for compliance screening,
// and we serve it for that purpose — but identity documents, dates of birth,
// contact details, and birth places present in the source are DROPPED at
// ingest. "Is this name designated, under which regime" needs none of them.

const UKSL_CSV_URL = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv';

const MAX_ALIASES = 15;
const MAX_COUNTRIES = 10;

export const ukSanctionsRecordSchema = z.object({
  unique_id: z.string(),
  /** Primary name as designated (name parts joined). */
  name: z.string(),
  aliases: z.array(z.string()),
  /** Individual | Entity | Ship (as published). */
  designation_type: z.string().nullable(),
  regime: z.string().nullable(),
  /** UK | UN (designations the UK implements) | ... as published. */
  designation_source: z.string().nullable(),
  sanctions_imposed: z.array(z.string()),
  /** Nationality / address countries, deduplicated. */
  countries: z.array(z.string()),
  date_designated: z.string().nullable(),
  last_updated: z.string().nullable(),
});

export type UkSanctionsRecord = z.infer<typeof ukSanctionsRecordSchema>;

/** dd/mm/yyyy → yyyy-mm-dd (UKSL date format); anything else → null. */
function isoDate(raw: string | undefined): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((raw ?? '').trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

interface Accumulator {
  record: UkSanctionsRecord;
  aliasSet: Set<string>;
  countrySet: Set<string>;
}

const REQUIRED_COLUMNS = [
  'Unique ID',
  'Name type',
  'Regime Name',
  'Designation Type',
  'Designation source',
  'Date Designated',
] as const;

function joinName(cols: string[], idx: Map<string, number>): string {
  // Name 1–5 are given/middle parts; Name 6 is the family/entity name.
  const parts = ['Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6']
    .map((key) => (cols[idx.get(key) ?? -1] ?? '').trim())
    .filter(Boolean);
  return parts.join(' ');
}

async function parseUksl(body: ReadableStream<Uint8Array>): Promise<UkSanctionsRecord[]> {
  const byId = new Map<string, Accumulator>();
  let idx: Map<string, number> | null = null;

  for await (const row of csvRows(body)) {
    if (idx === null) {
      // Skip the single-cell "Report Date: …" preamble; the first multi-cell
      // row is the header. Fail loud if the format shifted under us.
      if (row.length < 2) continue;
      idx = new Map(row.map((name, i) => [name.trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((c) => !idx!.has(c));
      if (missing.length > 0) {
        throw new Error(`UKSL CSV format changed — missing columns: ${missing.join(', ')}`);
      }
      continue;
    }
    const col = (name: string): string => (row[idx!.get(name) ?? -1] ?? '').trim();
    const id = col('Unique ID');
    if (!id) continue;

    let acc = byId.get(id);
    if (!acc) {
      acc = {
        record: {
          unique_id: id,
          name: '',
          aliases: [],
          designation_type: col('Designation Type') || null,
          regime: col('Regime Name') || null,
          designation_source: col('Designation source') || null,
          sanctions_imposed: col('Sanctions Imposed')
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean),
          countries: [],
          date_designated: isoDate(col('Date Designated')),
          last_updated: isoDate(col('Last Updated')),
        },
        aliasSet: new Set(),
        countrySet: new Set(),
      };
      byId.set(id, acc);
    }

    const fullName = joinName(row, idx);
    if (fullName) {
      const isPrimary = col('Name type').toLowerCase() === 'primary name';
      if (isPrimary && !acc.record.name) acc.record.name = fullName;
      else if (fullName !== acc.record.name) acc.aliasSet.add(fullName);
    }
    for (const country of [col('Address Country'), col('Nationality(/ies)')]
      .flatMap((v) => v.split(/[|,]/))
      .map((v) => v.trim())
      .filter(Boolean)) {
      acc.countrySet.add(country);
    }
  }

  const records: UkSanctionsRecord[] = [];
  for (const { record, aliasSet, countrySet } of byId.values()) {
    aliasSet.delete(record.name);
    if (!record.name) record.name = [...aliasSet][0] ?? record.unique_id;
    record.aliases = [...aliasSet].slice(0, MAX_ALIASES);
    record.countries = [...countrySet].slice(0, MAX_COUNTRIES);
    records.push(record);
  }
  return records;
}

export const ukSanctionsSource: DataSource<UkSanctionsRecord> = {
  slug: 'uk-sanctions',
  title: 'UK sanctions designations',
  description:
    'Every designation on the official UK Sanctions List (FCDO) — individuals, entities, and ships, with regimes, aliases, and dates — normalized for supplier due diligence. Served as published by government for compliance purposes; dates of birth, identity documents, and contact details are dropped at ingest.',
  stats: {
    date: { field: 'date_designated', title: 'Designations by month' },
    groupBy: [
      { field: 'regime', title: 'Designations by regime' },
      { field: 'designation_type', title: 'By designation type' },
      { field: 'designation_source', title: 'By designation source' },
    ],
  },
  recordSchema: ukSanctionsRecordSchema,
  queryParams: z.object({
    unique_id: z.string().optional(),
    name: z.string().optional(),
    regime: z.string().optional(),
    designation_type: z.string().optional(),
    designation_source: z.string().optional(),
    countries: z.string().optional(),
    date_designated_after: z.iso.date().optional(),
    date_designated_before: z.iso.date().optional(),
    last_updated_after: z.iso.date().optional(),
    last_updated_before: z.iso.date().optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  async fetchFresh(env: CloudflareBindings): Promise<UkSanctionsRecord[]> {
    try {
      const res = await originFetch(UKSL_CSV_URL, {
        headers: { accept: 'text/csv', 'user-agent': 'gankdat.com data refresh' },
      });
      if (!res.ok || !res.body) {
        throw new Error(`UKSL fetch failed: ${res.status}`);
      }
      const records = await parseUksl(res.body);
      if (records.length === 0) throw new Error('UKSL parse produced 0 records');
      // Completeness matters more than freshness for a sanctions list: a
      // plausible-but-partial parse is worse than a loud warning.
      if (records.length < 1000) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'suspiciously_small_refresh',
            source: 'uk-sanctions',
            records: records.length,
          }),
        );
      }
      return records;
    } catch (err) {
      // String() so the check survives the generated literal binding type
      // (prod pins FIXTURE_FALLBACK="false"), matching the other sources.
      if (String(env.FIXTURE_FALLBACK) === 'true') {
        console.log(
          JSON.stringify({ level: 'warn', event: 'fixture_fallback', source: 'uk-sanctions' }),
        );
        return z.array(ukSanctionsRecordSchema).parse(fixtureRecords);
      }
      throw err;
    }
  },
};
