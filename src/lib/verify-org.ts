// The "UK organisation verification" card behind the Zoho CRM extension (gankdat
// `zoho-crm-uk-registers-widget`, exchange 2026-W43): one call per register for the record's
// company name or number — uk-company-profiles (Companies House, lookup), uk-charities (the
// Charity Commission register) and uk-sanctions (the FCDO list) — folded into one card a related
// -list widget renders on an Account or Lead. Pure: the caller supplies the fetch (the widget uses
// the buyer's gankdat key; tests stub it), so the fold is testable without Zoho or the network.
// Each register that fails answers `unavailable` on its own line rather than failing the card.

export interface VerifyInput {
  /** Companies House number as typed (normalised server-side); wins over the name when present. */
  company_number?: string | null;
  /** The record's organisation name; used for the lookup when no number, and for the two searches. */
  name?: string | null;
}

export interface CompanyFacts {
  company_number: string;
  company: string;
  status: string | null;
  status_detail: string | null;
  company_type: string | null;
  incorporated_on: string | null;
  dissolved_on: string | null;
  accounts_overdue: boolean;
  confirmation_overdue: boolean;
  has_insolvency_history: boolean;
  has_been_liquidated: boolean;
  charges_outstanding: number;
  registered_office_in_dispute: boolean;
  previous_names: { name: string; ceased_on: string | null }[];
}

export interface CharityFacts {
  registered_charity_number: number;
  name: string;
  registration_status: string;
  latest_income: number | null;
  insolvent: boolean | null;
  in_administration: boolean | null;
  company_number: string | null;
}

export interface SanctionsHit {
  unique_id: string;
  name: string;
  regime: string | null;
  date_designated: string | null;
}

export type RegisterState = 'found' | 'none' | 'unavailable';

export interface VerificationCard {
  queried: { company_number: string | null; name: string | null };
  company: { state: RegisterState; facts: CompanyFacts | null };
  charity: { state: RegisterState; facts: CharityFacts | null; candidates: number };
  sanctions: { state: RegisterState; hits: SanctionsHit[]; matched_on: 'number' | 'name' | null };
  /** Plain-language lines the widget lists under the headline, worst first. */
  flags: string[];
  /** One line for the headline: what the three registers say together. */
  headline: string;
}

/** GET a gankdat REST path with query params; resolves to the envelope's `data` or throws. */
export type FetchRecords = (
  source: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>[]>;

/** The company-lookup params the input supports: a number wins over a name. */
export function lookupParams(input: VerifyInput): Record<string, string> | null {
  const number = input.company_number?.trim();
  if (number) return { company_number: number };
  const name = input.name?.trim();
  if (name) return { company: name };
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function companyFacts(r: Record<string, unknown>): CompanyFacts {
  const previous = Array.isArray(r.previous_names) ? r.previous_names : [];
  return {
    company_number: str(r.company_number) ?? '',
    company: str(r.company) ?? '',
    status: str(r.status),
    status_detail: str(r.status_detail),
    company_type: str(r.company_type),
    incorporated_on: str(r.incorporated_on),
    dissolved_on: str(r.dissolved_on),
    accounts_overdue: bool(r.accounts_overdue),
    confirmation_overdue: bool(r.confirmation_overdue),
    has_insolvency_history: bool(r.has_insolvency_history),
    has_been_liquidated: bool(r.has_been_liquidated),
    charges_outstanding: num(r.charges_outstanding) ?? 0,
    registered_office_in_dispute: bool(r.registered_office_in_dispute),
    previous_names: previous
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({ name: str(p.name) ?? '', ceased_on: str(p.ceased_on) })),
  };
}

export function charityFacts(r: Record<string, unknown>): CharityFacts {
  return {
    registered_charity_number: num(r.registered_charity_number) ?? 0,
    name: str(r.name) ?? '',
    registration_status: str(r.registration_status) ?? '',
    latest_income: num(r.latest_income),
    insolvent: typeof r.insolvent === 'boolean' ? r.insolvent : null,
    in_administration: typeof r.in_administration === 'boolean' ? r.in_administration : null,
    company_number: str(r.company_number),
  };
}

export function sanctionsHit(r: Record<string, unknown>): SanctionsHit {
  return {
    unique_id: str(r.unique_id) ?? '',
    name: str(r.name) ?? '',
    regime: str(r.regime),
    date_designated: str(r.date_designated),
  };
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\b(limited|ltd|plc|llp|cic|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A name search over a register returns neighbours too; keep the rows whose name matches ours. */
export function sameName(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  return x !== '' && x === y;
}

/** The charity rows that are this organisation: the company number when both sides have one, else the name. */
export function pickCharity(
  rows: Record<string, unknown>[],
  companyNumber: string | null,
  name: string | null,
): { facts: CharityFacts | null; candidates: number } {
  const facts = rows.map(charityFacts);
  if (companyNumber) {
    const byNumber = facts.find(
      (f) =>
        f.company_number &&
        f.company_number.replace(/^0+/, '') === companyNumber.replace(/^0+/, ''),
    );
    if (byNumber) return { facts: byNumber, candidates: facts.length };
  }
  if (name) {
    const byName = facts.filter((f) => sameName(f.name, name));
    if (byName.length === 1) return { facts: byName[0]!, candidates: facts.length };
  }
  return { facts: null, candidates: facts.length };
}

export function flagsOf(card: Omit<VerificationCard, 'flags' | 'headline'>): string[] {
  const out: string[] = [];
  if (card.sanctions.hits.length > 0) {
    out.push(
      `On the UK sanctions list: ${card.sanctions.hits.length} designation(s)${
        card.sanctions.hits[0]?.regime ? ` (${card.sanctions.hits[0].regime})` : ''
      }`,
    );
  }
  const c = card.company.facts;
  if (c) {
    if (c.status && c.status !== 'active')
      out.push(
        `Companies House status: ${c.status}${c.dissolved_on ? ` (dissolved ${c.dissolved_on})` : ''}`,
      );
    if (c.has_been_liquidated) out.push('Has been in liquidation');
    else if (c.has_insolvency_history) out.push('Has insolvency history');
    if (c.accounts_overdue) out.push('Accounts overdue at Companies House');
    if (c.confirmation_overdue) out.push('Confirmation statement overdue');
    if (c.registered_office_in_dispute) out.push('Registered office address in dispute');
    if (c.charges_outstanding > 0) out.push(`${c.charges_outstanding} outstanding charge(s)`);
  } else if (card.company.state === 'none') {
    out.push('No Companies House record for this name or number');
  }
  const ch = card.charity.facts;
  if (ch) {
    if (ch.registration_status && ch.registration_status.toLowerCase() !== 'registered')
      out.push(`Charity register status: ${ch.registration_status}`);
    if (ch.insolvent) out.push('Charity reported insolvent');
    if (ch.in_administration) out.push('Charity in administration');
  }
  for (const [reg, state] of [
    ['Companies House', card.company.state],
    ['Charity register', card.charity.state],
    ['Sanctions list', card.sanctions.state],
  ] as const) {
    if (state === 'unavailable') out.push(`${reg}: not checked (gankdat answered an error)`);
  }
  return out;
}

export function headlineOf(
  card: Omit<VerificationCard, 'flags' | 'headline'>,
  flags: string[],
): string {
  if (card.sanctions.hits.length > 0) return 'Sanctions match — do not proceed without review';
  const c = card.company.facts;
  if (c && c.status === 'active' && flags.length === 0) {
    return `Active company ${c.company_number}${card.charity.facts ? `, registered charity ${card.charity.facts.registered_charity_number}` : ''}, no sanctions match`;
  }
  if (c) return `${c.company} (${c.company_number}): ${flags.length} point(s) to check`;
  if (card.company.state === 'unavailable') return 'Companies House check unavailable — try again';
  if (card.charity.facts)
    return `Registered charity ${card.charity.facts.registered_charity_number}, no company record, no sanctions match`;
  return 'No UK register record found for this name';
}

/** Build the card: three register calls (the two searches in parallel after the lookup), folded. */
export async function verifyOrganisation(
  fetchRecords: FetchRecords,
  input: VerifyInput,
): Promise<VerificationCard> {
  const params = lookupParams(input);
  const queried = {
    company_number: input.company_number?.trim() || null,
    name: input.name?.trim() || null,
  };
  let company: VerificationCard['company'] = { state: 'none', facts: null };
  if (params) {
    try {
      const rows = await fetchRecords('uk-company-profiles', params);
      const row = rows[0];
      company = row ? { state: 'found', facts: companyFacts(row) } : { state: 'none', facts: null };
    } catch {
      company = { state: 'unavailable', facts: null };
    }
  }
  const number = company.facts?.company_number ?? queried.company_number;
  const name = company.facts?.company ?? queried.name;

  const [charityRows, sanctionRows] = await Promise.all([
    name ? fetchRecords('uk-charities', { q: name, per_page: '25' }).catch(() => null) : [],
    name ? fetchRecords('uk-sanctions', { q: name, per_page: '25' }).catch(() => null) : [],
  ]);

  const charity: VerificationCard['charity'] =
    charityRows === null
      ? { state: 'unavailable', facts: null, candidates: 0 }
      : (() => {
          const picked = pickCharity(charityRows, number, name);
          return { state: picked.facts ? 'found' : 'none', ...picked };
        })();

  const sanctions: VerificationCard['sanctions'] =
    sanctionRows === null
      ? { state: 'unavailable', hits: [], matched_on: null }
      : (() => {
          const hits = sanctionRows
            .filter((r) => {
              const n = str(r.name);
              const aliases = Array.isArray(r.aliases)
                ? r.aliases.filter((a): a is string => typeof a === 'string')
                : [];
              return name !== null && [n ?? '', ...aliases].some((x) => sameName(x, name));
            })
            .map(sanctionsHit);
          return {
            state: hits.length ? 'found' : 'none',
            hits,
            matched_on: hits.length ? 'name' : null,
          };
        })();

  const partial = { queried, company, charity, sanctions };
  const flags = flagsOf(partial);
  return { ...partial, flags, headline: headlineOf(partial, flags) };
}
