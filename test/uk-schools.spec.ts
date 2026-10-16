import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ukSchoolsSource } from '../src/sources/uk-schools';
import type { UkSchoolsRecord } from '../src/sources/uk-schools';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-schools';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukSchoolsSource);
}

// GIAS all-establishment layout: head-teacher and phone columns are present in
// the file and must not survive ingest.
const GIAS_HEADER = [
  'URN',
  'LA (code)',
  'LA (name)',
  'EstablishmentName',
  'TypeOfEstablishment (name)',
  'EstablishmentStatus (name)',
  'PhaseOfEducation (name)',
  'OpenDate',
  'CloseDate',
  'Street',
  'Locality',
  'Address3',
  'Town',
  'Postcode',
  'SchoolWebsite',
  'TelephoneNum',
  'HeadTitle (name)',
  'HeadFirstName',
  'HeadLastName',
  'SchoolCapacity',
  'NumberOfPupils',
  'StatutoryLowAge',
  'StatutoryHighAge',
  'OfstedRating (name)',
  'OfstedLastInsp',
  'GOR (name)',
  'Trusts (code)',
  'Trusts (name)',
].join(',');

const GIAS_ROWS = [
  '100000,201,City of London,The Aldgate School,Voluntary aided school,Open,Primary,01-01-1900,,"St James\'s Passage, Duke\'s Place",,,London,EC3A 5DE,https://www.thealdgateschool.org,02072831147,Mrs,Alexandra,Allan,270,240,3,11,Outstanding,13-03-2019,London,,',
  '103456,330,Birmingham,Northfield Academy,Academy converter,Open,Secondary,01-04-2012,,Northfield Road,Kings Norton,,Birmingham,B31 2HL,https://www.northfieldacademy.org.uk,01214751122,Mr,Tom,Reed,1200,1148,11,18,Good,17-05-2023,West Midlands,TR01234,Excalibur Learning Trust',
  '107890,892,Nottingham,Oakwood Studio School,Studio schools,Closed,Secondary,01-09-2013,31-08-2019,Oakwood Way,,,Nottingham,NG5 2BT,,01159151515,Ms,Jane,Patel,300,142,14,19,Inadequate,16-05-2018,East Midlands,,',
  '105678,373,Sheffield,Hilltop Nursery School,LA nursery school,Open,Nursery,01-09-1972,,Hilltop Lane,,,Sheffield,S6 3AA,,01142734567,Mrs,Sara,Obi,80,72,2,5,Outstanding,19-09-2018,Yorkshire and the Humber,,',
  'NOTANURN,201,City of London,Bad Row,Community school,Open,Primary,,,,,,,,,,,,,,,,,,,,,',
].join('\r\n');

const GIAS_CSV = `${GIAS_HEADER}\r\n${GIAS_ROWS}`;

const OFSTED_CONTENT = {
  details: {
    attachments: [
      {
        title: 'Management information - state-funded schools - year to date',
        content_type: 'text/csv',
        url: 'https://assets.publishing.service.gov.uk/media/aaa/ytd.csv',
      },
      {
        title: 'Management information - state-funded schools - most recent inspections',
        content_type: 'text/csv',
        url: 'https://assets.publishing.service.gov.uk/media/bbb/latest.csv',
      },
    ],
  },
};

// Ofsted publishes a numeric grade; a couple of title lines sit above the header.
const OFSTED_CSV = [
  "Ofsted's school inspections outcomes",
  'Management information as at 31 August 2026',
  'URN,School name,Overall effectiveness,Inspection start date',
  '100000,The Aldgate School,2,04-06-2026',
  '103456,Northfield Academy,1,12-09-2024',
  '105678,Hilltop Nursery School,1,11-02-2015',
].join('\r\n');

function giasOk(url: string): Response {
  // Only "yesterday's" file exists in this stub — the source walks back to it.
  const day = new Date(Date.now() - 86_400_000);
  const stamp = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(
    day.getUTCDate(),
  ).padStart(2, '0')}`;
  return url.includes(`edubasealldata${stamp}.csv`)
    ? new Response(GIAS_CSV, { headers: { 'content-type': 'text/csv' } })
    : new Response('not found', { status: 404 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-schools', () => {
  it('walks back to the published GIAS day, normalizes, and drops head names and phones', async () => {
    const mock = stubOrigins({
      govukContent: () => Response.json(OFSTED_CONTENT),
      govukAsset: () => new Response(OFSTED_CSV, { headers: { 'content-type': 'text/csv' } }),
      gias: giasOk,
    });
    await load();
    const tried = mock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('edubasealldata'));
    expect(tried.length).toBeGreaterThanOrEqual(2); // today 404s, yesterday serves

    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('02072831147');
    expect(text).not.toContain('Alexandra');
    expect(text).not.toContain('Allan');
    expect(text.toLowerCase()).not.toContain('head');
    expect(text.toLowerCase()).not.toContain('telephone');

    const body = JSON.parse(text) as SuccessEnvelope<UkSchoolsRecord[]>;
    expect(body.data).toHaveLength(4); // the row with a non-numeric URN is skipped
    const aldgate = body.data.find((r) => r.urn === '100000');
    expect(aldgate).toEqual({
      urn: '100000',
      name: 'The Aldgate School',
      establishment_type: 'Voluntary aided school',
      phase: 'Primary',
      status: 'Open',
      local_authority: 'City of London',
      region: 'London',
      address: "St James's Passage, Duke's Place",
      town: 'London',
      postcode: 'EC3A 5DE',
      outward_code: 'EC3A',
      website: 'https://www.thealdgateschool.org',
      school_capacity: 270,
      pupils: 240,
      statutory_low_age: 3,
      statutory_high_age: 11,
      trust_name: null,
      trust_id: null,
      open_date: '1900-01-01',
      close_date: null,
      // Ofsted's June 2026 inspection is newer than the GIAS column, so it wins.
      ofsted_rating: 'Good',
      ofsted_last_inspection: '2026-06-04',
      gias_url:
        'https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/100000',
    });
  });

  it('keeps the GIAS verdict when the Ofsted file is older, and joins trusts and close dates', async () => {
    stubOrigins({
      govukContent: () => Response.json(OFSTED_CONTENT),
      govukAsset: () => new Response(OFSTED_CSV),
      gias: giasOk,
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSchoolsRecord[]>;
    // Ofsted MI has a 2015 inspection for Hilltop; GIAS's 2018 one is newer.
    expect(body.data.find((r) => r.urn === '105678')).toMatchObject({
      ofsted_rating: 'Outstanding',
      ofsted_last_inspection: '2018-09-19',
    });
    expect(body.data.find((r) => r.urn === '103456')).toMatchObject({
      trust_name: 'Excalibur Learning Trust',
      trust_id: 'TR01234',
      ofsted_rating: 'Outstanding', // numeric grade 1 mapped, and it is newer
      ofsted_last_inspection: '2024-09-12',
    });
    expect(body.data.find((r) => r.urn === '107890')).toMatchObject({
      status: 'Closed',
      close_date: '2019-08-31',
    });
  });

  it('filters by phase, region, trust, Ofsted rating, pupils and inspection date', async () => {
    stubOrigins({
      govukContent: () => Response.json(OFSTED_CONTENT),
      govukAsset: () => new Response(OFSTED_CSV),
      gias: giasOk,
    });
    await load();
    const { key } = await issueKey();
    const names = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkSchoolsRecord[]
      >;
      return body.data.map((r) => r.name);
    };
    expect(await names('phase=nursery')).toEqual(['Hilltop Nursery School']);
    expect(await names('region=west midlands')).toEqual(['Northfield Academy']);
    expect(await names('trust_name=excalibur')).toEqual(['Northfield Academy']);
    expect(await names('ofsted_rating=inadequate')).toEqual(['Oakwood Studio School']);
    expect(await names('status=closed')).toEqual(['Oakwood Studio School']);
    expect(await names('outward_code=ec3a')).toEqual(['The Aldgate School']);
    expect(await names('pupils_min=1000')).toEqual(['Northfield Academy']);
    expect(await names('ofsted_last_inspection_after=2026-01-01')).toEqual(['The Aldgate School']);
  });

  it('still ingests GIAS when the Ofsted enrichment is unavailable', async () => {
    stubOrigins({
      govukContent: () => new Response('nope', { status: 503 }),
      gias: giasOk,
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSchoolsRecord[]>;
    expect(body.data).toHaveLength(4);
    // Falls back to the Ofsted columns GIAS itself carries.
    expect(body.data.find((r) => r.urn === '100000')).toMatchObject({
      ofsted_rating: 'Outstanding',
      ofsted_last_inspection: '2019-03-13',
    });
  });

  it('refuses an Ofsted attachment on another host but keeps the GIAS load', async () => {
    stubOrigins({
      govukContent: () =>
        Response.json({
          details: {
            attachments: [{ content_type: 'text/csv', url: 'https://evil.example/x.csv' }],
          },
        }),
      gias: giasOk,
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSchoolsRecord[]>;
    expect(body.data).toHaveLength(4);
  });

  it('falls back to bundled fixtures when GIAS is unreachable', async () => {
    stubOrigins({
      govukContent: () => Response.json(OFSTED_CONTENT),
      govukAsset: () => new Response(OFSTED_CSV),
      gias: () => new Response('nope', { status: 503 }),
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSchoolsRecord[]>;
    expect(body.meta?.total).toBe(30);
  });
});
