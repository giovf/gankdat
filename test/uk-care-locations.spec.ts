import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ukCareLocationsSource } from '../src/sources/uk-care-locations';
import type { UkCareLocationsRecord } from '../src/sources/uk-care-locations';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-care-locations';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukCareLocationsSource);
}

const INDEX_HTML =
  '<html><body><a href="/system/files/2026-09/01_September_2026_Latest_ratings.ods">ratings</a>' +
  '<a href="https://www.cqc.org.uk/system/files/2026-09/16_september_2026_CQC_directory.csv">CSV</a>' +
  '<a href="https://www.cqc.org.uk/system/files/2026-09/16_september_2026_CQC_directory.zip">ZIP</a></body></html>';

// Real layout (16 Sep 2026 file): preamble lines, then the header, then rows.
const CSV = [
  'CQC Locations data,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,',
  'This data was produced on 16 September 2026,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,',
  "Name,Also known as,Address,Postcode,Phone number,Service's website (if available),Service types,Date of latest check,Specialisms/services,Provider name,Local authority,Region,Location URL,CQC Location ID (for office use only),CQC Provider ID (for office use only)",
  'Square Mile Dental Centre,,"7-9 White Kennet Street,London",E1 7BS,2073770990,,Dentist,09/Jan/2018 - 00:00,Services for everyone,Square Mile Dental Centre Limited,City of London,London,https://www.cqc.org.uk/location/1-10552899555,1-10552899555,1-10006912129',
  'Helping Hands Mansfield,,"Room 107, Level 1, East Wing,Mansfield Business Centre, Ashfield Avenue,Mansfield",NG18 2AE,7436315363,,Homecare agencies,19/May/2022 - 00:00,Caring for adults under 65 yrs|Dementia|Caring for adults over 65 yrs|Physical disabilities,Midshires Care Limited,Nottinghamshire,East Midlands,https://www.cqc.org.uk/location/1-10553191017,1-10553191017,1-101671690',
  'Rose Lodge,Rose Lodge Care Home,"1 Garden Way,Leeds",LS1 4AB,,www.roselodge.example,Care home|Nursing home,22/Jan/2025 - 00:00,Dementia|Caring for adults over 65 yrs,Rose Care Ltd,Leeds,Yorkshire & Humberside,https://www.cqc.org.uk/location/1-2000000001,1-2000000001,1-3000000001',
  'No Id Clinic,,"2 Some Road,Bath",BA1 1AA,,,GP,,,,Bath and North East Somerset,South West,,,',
].join('\r\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-care-locations', () => {
  it('resolves the dated CSV from the data page, skips the preamble, normalizes, drops phone numbers', async () => {
    const mock = stubOrigins({
      cqcPage: () => new Response(INDEX_HTML, { headers: { 'content-type': 'text/html' } }),
      cqcFile: () => new Response(CSV, { headers: { 'content-type': 'text/csv' } }),
    });
    await load();
    const file = mock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/system/files/'));
    expect(file).toContain('16_september_2026_CQC_directory.csv');
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('2073770990');
    expect(text).not.toContain('7436315363');
    expect(text.toLowerCase()).not.toContain('phone');
    const body = JSON.parse(text) as SuccessEnvelope<UkCareLocationsRecord[]>;
    expect(body.data).toHaveLength(3); // the row without a location id is skipped
    expect(body.data[0]).toEqual({
      location_id: '1-10552899555',
      provider_id: '1-10006912129',
      name: 'Square Mile Dental Centre',
      also_known_as: null,
      address: '7-9 White Kennet Street, London',
      postcode: 'E1 7BS',
      outward_code: 'E1',
      website: null,
      service_types: 'Dentist',
      latest_check_date: '2018-01-09',
      specialisms: 'Services for everyone',
      provider_name: 'Square Mile Dental Centre Limited',
      local_authority: 'City of London',
      region: 'London',
      cqc_url: 'https://www.cqc.org.uk/location/1-10552899555',
    });
    const rose = body.data.find((r) => r.name === 'Rose Lodge');
    expect(rose).toMatchObject({
      also_known_as: 'Rose Lodge Care Home',
      service_types: 'Care home|Nursing home',
      latest_check_date: '2025-01-22',
      website: 'www.roselodge.example',
    });
  });

  it('filters by service type, region, specialism and check date', async () => {
    stubOrigins({ cqcPage: () => new Response(INDEX_HTML), cqcFile: () => new Response(CSV) });
    await load();
    const { key } = await issueKey();
    const names = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkCareLocationsRecord[]
      >;
      return body.data.map((r) => r.name);
    };
    expect(await names('service_types=nursing home')).toEqual(['Rose Lodge']);
    expect(await names('region=east midlands')).toEqual(['Helping Hands Mansfield']);
    expect(await names('specialisms=dementia')).toEqual(['Helping Hands Mansfield', 'Rose Lodge']);
    expect(await names('latest_check_date_after=2024-01-01')).toEqual(['Rose Lodge']);
    expect(await names('outward_code=e1')).toEqual(['Square Mile Dental Centre']);
  });

  it('refuses a directory link on another host and falls back to fixtures', async () => {
    stubOrigins({
      cqcPage: () => new Response('<a href="https://evil.example/x_CQC_directory.csv">x</a>'),
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkCareLocationsRecord[]
    >;
    expect(body.meta?.total).toBe(30);
  });

  it('falls back to bundled fixtures when the data page fails', async () => {
    stubOrigins({ cqcPage: () => new Response('nope', { status: 503 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkCareLocationsRecord[]
    >;
    expect(body.meta?.total).toBe(30);
  });
});
