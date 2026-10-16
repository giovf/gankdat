// "Businesses without a website" lead feed: unions three gankdat register datasets
// (CQC care locations, Charity Commission register, DfE schools) filtered with
// website_present=false into one row shape, charging one pay-per-event "result" per
// record and stopping cleanly at the user's spending limit. Organisation-level data
// only — the registers' contact names, phones and emails are never ingested by gankdat.
import { Actor, log } from 'apify';

const API = 'https://gankdat.com/v1/data';
const PER_PAGE = 100;

const clean = (v) => (v === undefined || v === null || v === '' ? undefined : v);

/** One entry per sector: which dataset, which filters from the input, and how to map a row. */
const SECTORS = {
  care: {
    dataset: 'uk-care-locations',
    filters: (i) => ({
      region: clean(i.region),
      local_authority: clean(i.local_authority),
      outward_code: clean(i.outward_code),
      service_types: clean(i.care_service_types),
    }),
    map: (r) => ({
      sector: 'care',
      name: r.name,
      organisation_type: r.service_types,
      address: r.address,
      postcode: r.postcode,
      outward_code: r.outward_code,
      local_authority: r.local_authority,
      region: r.region,
      size_hint: r.provider_name ? `provider: ${r.provider_name}` : null,
      registered_since: r.latest_check_date ? `last CQC check ${r.latest_check_date}` : null,
      source_dataset: 'uk-care-locations',
      source_id: r.location_id,
      source_url: r.cqc_url,
    }),
  },
  charity: {
    dataset: 'uk-charities',
    filters: (i) => ({
      outward_code: clean(i.outward_code),
      latest_income_min: i.charity_income_min ?? 25000,
      registration_status: 'Registered',
    }),
    // Charities carry no region/local authority; an area filter on those means "no rows".
    skipWhen: (i) => Boolean(clean(i.region) || clean(i.local_authority)),
    map: (r) => ({
      sector: 'charity',
      name: r.name,
      organisation_type: r.charity_type,
      address: null,
      postcode: r.postcode,
      outward_code: r.outward_code,
      local_authority: null,
      region: null,
      size_hint: r.latest_income != null ? `income £${Math.round(r.latest_income)}` : null,
      registered_since: r.date_of_registration,
      source_dataset: 'uk-charities',
      source_id: String(r.registered_charity_number),
      source_url: `https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/${r.organisation_number}`,
    }),
  },
  school: {
    dataset: 'uk-schools',
    filters: (i) => ({
      region: clean(i.region),
      local_authority: clean(i.local_authority),
      outward_code: clean(i.outward_code),
      phase: clean(i.school_phase),
      status: 'Open',
    }),
    map: (r) => ({
      sector: 'school',
      name: r.name,
      organisation_type: [r.phase, r.establishment_type].filter(Boolean).join(' · ') || null,
      address: [r.address, r.town].filter(Boolean).join(', ') || null,
      postcode: r.postcode,
      outward_code: r.outward_code,
      local_authority: r.local_authority,
      region: r.region,
      size_hint: r.pupils != null ? `${r.pupils} pupils` : null,
      registered_since: r.open_date,
      source_dataset: 'uk-schools',
      source_id: r.urn,
      source_url: r.gias_url,
    }),
  },
};

async function* pages(dataset, filters, key) {
  const params = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      ...params,
      website_present: 'false',
      page: String(page),
      per_page: String(PER_PAGE),
    });
    const res = await fetch(`${API}/${dataset}?${qs}`, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': 'gankdat-apify-actor/1.2' },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '5') * 1000;
      log.warning(`Rate limited by the API; waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`gankdat API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const records = body.data ?? [];
    yield { records, total: body.meta?.total ?? null, page };
    if (records.length < PER_PAGE) return;
    page += 1;
  }
}

/** @param {Record<string, unknown>} input actor input */
export async function runLeadFeed(input) {
  const key = process.env.GANKDAT_API_KEY;
  if (!key) throw new Error('GANKDAT_API_KEY is not configured on this actor');
  const maxResults = Number(input.max_results ?? 1000);
  const wanted =
    Array.isArray(input.sectors) && input.sectors.length ? input.sectors : Object.keys(SECTORS);
  let pushed = 0;
  let matched = 0;
  for (const name of wanted) {
    const sector = SECTORS[name];
    if (!sector) {
      log.warning(`Unknown sector "${name}" skipped`);
      continue;
    }
    if (sector.skipWhen?.(input)) {
      log.info(`${name}: skipped — this register has no region/local authority field`);
      continue;
    }
    for await (const { records, total, page } of pages(
      sector.dataset,
      sector.filters(input),
      key,
    )) {
      if (page === 1) {
        matched += total ?? 0;
        log.info(`${name}: ${total ?? '?'} organisations without a website match`);
      }
      for (const record of records) {
        if (pushed >= maxResults) break;
        const charge = await Actor.charge({ eventName: 'result' });
        if (charge.eventChargeLimitReached) {
          log.warning(
            'Spending limit reached; stopping. Raise the max total charge to get more results.',
          );
          await Actor.setStatusMessage(`Stopped at ${pushed} results (spending limit).`);
          return pushed;
        }
        await Actor.pushData(sector.map(record));
        pushed += 1;
      }
      if (pushed >= maxResults) break;
    }
    if (pushed >= maxResults) break;
  }
  await Actor.setStatusMessage(
    `Done: ${pushed} leads (${matched} matched across ${wanted.length} register(s), refreshed daily from official sources).`,
  );
  return pushed;
}
