import { z } from 'zod';
import fixture from './fixtures/uk-company-profiles.json';
import type { DataSource } from './types';

// Companies House — company lookup + monitor (exchange 2026-W41 winner, built
// 2026-10-07). The register is 5.4M companies, so this is the platform's first
// on-demand dataset (`DataSource.lookup`): a request names one company by
// number (or by name, resolved through the search endpoint to its top hit) and
// the Worker reads ≤ 4 resources from the official public-data API —
// profile, charges, filing history, persons with significant control — into
// one record, cached in KV for 24 h. Layouts verified against the API's
// resource pages through the relay on 2026-10-07 (companyProfile, chargeList,
// filingHistoryList, the PSC list and companySearch resources; the bundled
// fixture is hand-built to those layouts because the API needs a key the
// relay cannot carry). Crown copyright, attribute Companies House.
//
// Blind Mode (GDPR.md LIA table, owner decision 2026-09-20): organisation-level
// fields only. Officer endpoints are never called; the PSC list is read for
// its corporate and legal-person entries and its counts — an individual's
// entry is dropped whole (name, date of birth, nationality, residence,
// address) at ingest; filing events keep the category/type/description KEY
// (e.g. `appoint-person-director-company-with-name`), never the
// description_values that carry the officer's name; charge entries drop
// persons_entitled; registered-office address lines are dropped as in
// uk-companies. Requires COMPANIES_HOUSE_API_KEY (HTTP Basic, key as username;
// 600 requests / 5 min shared with uk-companies — the per-source rate limit
// below keeps a full-speed client under a quarter of that).
const API_URL = 'https://api.company-information.service.gov.uk';
const FILINGS_KEPT = 25;
const CHARGES_KEPT = 25;
const CONTROLLERS_PER_PAGE = 100;
const ORIGIN_TIMEOUT_MS = 10_000;

const dateish = z.string().nullish();

const profileSchema = z.object({
  company_name: z.string(),
  company_number: z.string(),
  company_status: z.string().nullish(),
  company_status_detail: z.string().nullish(),
  type: z.string().nullish(),
  subtype: z.string().nullish(),
  jurisdiction: z.string().nullish(),
  date_of_creation: dateish,
  date_of_cessation: dateish,
  sic_codes: z.array(z.coerce.string()).nullish(),
  has_charges: z.boolean().nullish(),
  has_insolvency_history: z.boolean().nullish(),
  has_been_liquidated: z.boolean().nullish(),
  registered_office_is_in_dispute: z.boolean().nullish(),
  undeliverable_registered_office_address: z.boolean().nullish(),
  registered_office_address: z
    .object({
      locality: z.string().nullish(),
      region: z.string().nullish(),
      postal_code: z.string().nullish(),
      country: z.string().nullish(),
    })
    .nullish(),
  accounts: z
    .object({
      last_accounts: z
        .object({ period_end_on: dateish, made_up_to: dateish, type: z.string().nullish() })
        .nullish(),
      next_accounts: z.object({ due_on: dateish, overdue: z.boolean().nullish() }).nullish(),
      next_due: dateish,
      overdue: z.boolean().nullish(),
    })
    .nullish(),
  confirmation_statement: z
    .object({ last_made_up_to: dateish, next_due: dateish, overdue: z.boolean().nullish() })
    .nullish(),
  previous_company_names: z
    .array(z.object({ name: z.string(), ceased_on: dateish, effective_from: dateish }))
    .nullish(),
});

// The spec page renders `classification` as an array of objects; the live API
// serves an object. Accept both and read the first.
const typed = z.object({ type: z.string().nullish(), description: z.string().nullish() });
const oneOrMany = z.union([typed, z.array(typed)]).nullish();

const chargeListSchema = z.object({
  total_count: z.number().nullish(),
  satisfied_count: z.number().nullish(),
  part_satisfied_count: z.number().nullish(),
  items: z
    .array(
      z.object({
        charge_code: z.string().nullish(),
        charge_number: z.number().nullish(),
        classification: oneOrMany,
        status: z.string().nullish(),
        created_on: dateish,
        delivered_on: dateish,
        satisfied_on: dateish,
      }),
    )
    .nullish(),
});

const filingListSchema = z.object({
  total_count: z.number().nullish(),
  items: z
    .array(
      z.object({
        date: dateish,
        category: z.string().nullish(),
        subcategory: z.string().nullish(),
        type: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .nullish(),
});

const CORPORATE_KINDS = new Set([
  'corporate-entity-person-with-significant-control',
  'legal-person-with-significant-control',
  'corporate-entity-beneficial-owner',
  'legal-person-beneficial-owner',
]);

const pscListSchema = z.object({
  active_count: z.number().nullish(),
  ceased_count: z.number().nullish(),
  total_results: z.number().nullish(),
  items: z
    .array(
      z.object({
        kind: z.string().nullish(),
        name: z.string().nullish(),
        ceased: z.boolean().nullish(),
        ceased_on: dateish,
        notified_on: dateish,
        natures_of_control: z.array(z.string()).nullish(),
        identification: z
          .object({
            legal_form: z.string().nullish(),
            country_registered: z.string().nullish(),
            place_registered: z.string().nullish(),
            registration_number: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

const searchSchema = z.object({
  items: z.array(z.object({ company_number: z.string() }).loose()).nullish(),
});

const chargeSchema = z.object({
  charge_code: z.string().nullable(),
  status: z.string().nullable(),
  classification: z.string().nullable(),
  created_on: z.string().nullable(),
  satisfied_on: z.string().nullable(),
});

const filingSchema = z.object({
  date: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
});

const controllerSchema = z.object({
  name: z.string(),
  kind: z.string(),
  legal_form: z.string().nullable(),
  country_registered: z.string().nullable(),
  registration_number: z.string().nullable(),
  natures_of_control: z.array(z.string()),
  notified_on: z.string().nullable(),
  ceased_on: z.string().nullable(),
});

export const ukCompanyProfilesRecordSchema = z.object({
  company_number: z.string(),
  company: z.string(),
  status: z.string().nullable(),
  status_detail: z.string().nullable(),
  company_type: z.string().nullable(),
  subtype: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  incorporated_on: z.string().nullable(),
  dissolved_on: z.string().nullable(),
  sic_codes: z.array(z.string()),
  previous_names: z.array(z.object({ name: z.string(), ceased_on: z.string().nullable() })),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  registered_office_in_dispute: z.boolean(),
  accounts_type: z.string().nullable(),
  accounts_last_period_end: z.string().nullable(),
  accounts_next_due: z.string().nullable(),
  accounts_overdue: z.boolean(),
  confirmation_last_made_up_to: z.string().nullable(),
  confirmation_next_due: z.string().nullable(),
  confirmation_overdue: z.boolean(),
  has_charges: z.boolean(),
  has_insolvency_history: z.boolean(),
  has_been_liquidated: z.boolean(),
  charges_total: z.number(),
  charges_outstanding: z.number(),
  charges_satisfied: z.number(),
  charges: z.array(chargeSchema),
  filings_total: z.number(),
  filings: z.array(filingSchema),
  controllers_active: z.number(),
  controllers_ceased: z.number(),
  individual_controllers: z.number(),
  corporate_controllers: z.array(controllerSchema),
  company_url: z.string(),
});

export type UkCompanyProfilesRecord = z.infer<typeof ukCompanyProfilesRecordSchema>;

interface RawCompany {
  profile: z.infer<typeof profileSchema>;
  charges: z.infer<typeof chargeListSchema> | null;
  filing_history: z.infer<typeof filingListSchema> | null;
  pscs: z.infer<typeof pscListSchema> | null;
}

function first<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalize(raw: RawCompany): UkCompanyProfilesRecord {
  const p = raw.profile;
  const address = p.registered_office_address ?? undefined;
  const chargeItems = raw.charges?.items ?? [];
  const chargesTotal = raw.charges?.total_count ?? chargeItems.length;
  const satisfied = raw.charges?.satisfied_count ?? 0;
  const partSatisfied = raw.charges?.part_satisfied_count ?? 0;
  const pscItems = raw.pscs?.items ?? [];
  const corporate = pscItems.filter((i) => CORPORATE_KINDS.has(i.kind ?? ''));
  return {
    company_number: p.company_number,
    company: p.company_name,
    status: p.company_status ?? null,
    status_detail: p.company_status_detail ?? null,
    company_type: p.type ?? null,
    subtype: p.subtype ?? null,
    jurisdiction: p.jurisdiction ?? null,
    incorporated_on: p.date_of_creation ?? null,
    dissolved_on: p.date_of_cessation ?? null,
    sic_codes: p.sic_codes ?? [],
    previous_names: (p.previous_company_names ?? []).map((n) => ({
      name: n.name,
      ceased_on: n.ceased_on ?? null,
    })),
    locality: address?.locality ?? null,
    region: address?.region ?? null,
    postal_code: address?.postal_code ?? null,
    country: address?.country ?? null,
    registered_office_in_dispute: p.registered_office_is_in_dispute ?? false,
    accounts_type: p.accounts?.last_accounts?.type ?? null,
    accounts_last_period_end:
      p.accounts?.last_accounts?.period_end_on ?? p.accounts?.last_accounts?.made_up_to ?? null,
    accounts_next_due: p.accounts?.next_accounts?.due_on ?? p.accounts?.next_due ?? null,
    accounts_overdue: p.accounts?.next_accounts?.overdue ?? p.accounts?.overdue ?? false,
    confirmation_last_made_up_to: p.confirmation_statement?.last_made_up_to ?? null,
    confirmation_next_due: p.confirmation_statement?.next_due ?? null,
    confirmation_overdue: p.confirmation_statement?.overdue ?? false,
    has_charges: p.has_charges ?? chargesTotal > 0,
    has_insolvency_history: p.has_insolvency_history ?? false,
    has_been_liquidated: p.has_been_liquidated ?? false,
    charges_total: chargesTotal,
    charges_outstanding: Math.max(0, chargesTotal - satisfied - partSatisfied),
    charges_satisfied: satisfied,
    charges: chargeItems.slice(0, CHARGES_KEPT).map((c) => ({
      charge_code:
        c.charge_code ?? (c.charge_number === undefined ? null : String(c.charge_number)),
      status: c.status ?? null,
      classification: first(c.classification)?.description ?? first(c.classification)?.type ?? null,
      created_on: c.created_on ?? c.delivered_on ?? null,
      satisfied_on: c.satisfied_on ?? null,
    })),
    filings_total: raw.filing_history?.total_count ?? (raw.filing_history?.items ?? []).length,
    filings: (raw.filing_history?.items ?? []).slice(0, FILINGS_KEPT).map((f) => ({
      date: f.date ?? null,
      category: f.category ?? null,
      subcategory: f.subcategory ?? null,
      type: f.type ?? null,
      description: f.description ?? null,
    })),
    controllers_active: raw.pscs?.active_count ?? pscItems.filter((i) => !i.ceased).length,
    controllers_ceased: raw.pscs?.ceased_count ?? pscItems.filter((i) => i.ceased).length,
    individual_controllers: pscItems.length - corporate.length,
    corporate_controllers: corporate.map((c) => ({
      name: c.name ?? '',
      kind: c.kind ?? '',
      legal_form: c.identification?.legal_form ?? null,
      country_registered:
        c.identification?.country_registered ?? c.identification?.place_registered ?? null,
      registration_number: c.identification?.registration_number ?? null,
      natures_of_control: c.natures_of_control ?? [],
      notified_on: c.notified_on ?? null,
      ceased_on: c.ceased_on ?? null,
    })),
    company_url: `https://find-and-update.company-information.service.gov.uk/company/${p.company_number}`,
  };
}

/**
 * Companies House numbers are eight characters: digits left-padded with zeros
 * ("6" → "00000006"), or a two-letter prefix and six digits ("SC1234" →
 * "SC001234"). Anything else is passed through upper-cased.
 */
export function normalizeCompanyNumber(input: string): string {
  const n = input.trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,8}$/.test(n)) return n.padStart(8, '0');
  const prefixed = /^([A-Z]{2})(\d{1,6})$/.exec(n);
  if (prefixed) return `${prefixed[1]}${prefixed[2].padStart(6, '0')}`;
  return n;
}

async function originGet(key: string, path: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    headers: {
      authorization: `Basic ${btoa(`${key}:`)}`,
      'user-agent': 'gankdat.com company lookup',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
  });
}

/** A sub-resource: 404 means the company has none (the API answers so for charges and PSCs). */
async function optionalResource<T>(
  key: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const res = await originGet(key, path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`company-information.service.gov.uk responded ${res.status}`);
  return schema.parse(await res.json());
}

async function resolveNumber(key: string, params: Record<string, unknown>): Promise<string | null> {
  const number = params.company_number;
  if (typeof number === 'string' && number.trim() !== '') return normalizeCompanyNumber(number);
  const name = params.company;
  if (typeof name !== 'string' || name.trim() === '') return null;
  const res = await originGet(
    key,
    `/search/companies?q=${encodeURIComponent(name.trim())}&items_per_page=1`,
  );
  if (!res.ok) throw new Error(`company-information.service.gov.uk responded ${res.status}`);
  const hit = searchSchema.parse(await res.json()).items?.[0];
  return hit ? normalizeCompanyNumber(hit.company_number) : null;
}

async function fetchFromOrigin(
  key: string,
  params: Record<string, unknown>,
): Promise<UkCompanyProfilesRecord | null> {
  const number = await resolveNumber(key, params);
  if (!number) return null;
  const path = `/company/${encodeURIComponent(number)}`;
  const profile = await optionalResource(key, path, profileSchema);
  if (!profile) return null;
  const [charges, filing_history, pscs] = await Promise.all([
    optionalResource(key, `${path}/charges`, chargeListSchema),
    optionalResource(
      key,
      `${path}/filing-history?items_per_page=${FILINGS_KEPT}`,
      filingListSchema,
    ),
    optionalResource(
      key,
      `${path}/persons-with-significant-control?items_per_page=${CONTROLLERS_PER_PAGE}`,
      pscListSchema,
    ),
  ]);
  return normalize({ profile, charges, filing_history, pscs });
}

const fixtureSchema = z.object({
  companies: z.array(
    z.object({
      profile: profileSchema,
      charges: chargeListSchema.nullable(),
      filing_history: filingListSchema.nullable(),
      pscs: pscListSchema.nullable(),
    }),
  ),
});

function fixtureRecords(): UkCompanyProfilesRecord[] {
  return fixtureSchema.parse(fixture).companies.map(normalize);
}

function fixtureFor(params: Record<string, unknown>): UkCompanyProfilesRecord | null {
  const records = fixtureRecords();
  const number =
    typeof params.company_number === 'string'
      ? normalizeCompanyNumber(params.company_number)
      : null;
  const name = typeof params.company === 'string' ? params.company.trim().toLowerCase() : null;
  return (
    records.find(
      (r) =>
        r.company_number === number || (name !== null && r.company.toLowerCase().includes(name)),
    ) ??
    records[0] ??
    null
  );
}

export const ukCompanyProfilesSource: DataSource<UkCompanyProfilesRecord> = {
  slug: 'uk-company-profiles',
  title: 'UK company lookup (Companies House)',
  description:
    'One UK company by number or name, live from the official Companies House API: profile, status, type, SIC codes, registered-office area, accounts and confirmation-statement dates and overdue flags, charges, the latest filing events and corporate persons with significant control. Blind Mode: officers and individual PSCs are never ingested — filing events carry the category code, not the name. Cached 24 h.',
  recordSchema: ukCompanyProfilesRecordSchema,
  queryParams: z.object({
    company_number: z.string().trim().min(1).max(12).optional(),
    company: z.string().trim().min(2).max(160).optional(),
  }),
  lookup: {
    keys: ['company_number', 'company'],
    example: { company_number: '00000006' },
    cacheTtlSeconds: 86_400,
    fetchOne: async (env, params) => {
      try {
        const key = String(env.COMPANIES_HOUSE_API_KEY ?? '');
        if (key === '') throw new Error('COMPANIES_HOUSE_API_KEY not configured');
        return await fetchFromOrigin(key, params);
      } catch (err) {
        if (String(env.FIXTURE_FALLBACK) === 'true') {
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'fixture_fallback',
              source: 'uk-company-profiles',
              reason: err instanceof Error ? err.message : String(err),
            }),
          );
          return fixtureFor(params);
        }
        throw err;
      }
    },
  },
  // The origin allows 600 requests per 5 minutes across both Companies House
  // sources and a cold lookup is up to 5 of them; 30/min per account keeps
  // one client well inside that even before the KV cache absorbs repeats.
  rateLimit: { limit: 30, windowSeconds: 60 },
  x402PriceUsd: '$0.01',
  // No snapshot: the cron waves skip lookup sources (store.ts cronSources).
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  // Sample records for the schema checks (Blind Mode, Apify); lookups go through `lookup.fetchOne`.
  fetchFresh: () => Promise.resolve(fixtureRecords()),
};
