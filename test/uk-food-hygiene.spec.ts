import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ukFoodHygieneSource } from '../src/sources/uk-food-hygiene';
import type { UkFoodHygieneRecord } from '../src/sources/uk-food-hygiene';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-food-hygiene';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukFoodHygieneSource);
}

// Real column layout of FHRS_All_en-GB.csv (2026-09-20), BOM included.
const CSV =
  '\uFEFF' +
  [
    'AddressLine1,AddressLine2,AddressLine3,AddressLine4,BusinessTypeID,FHRSID,BusinessName,BusinessType,ConfidenceInManagement,Hygiene,Latitude,LocalAuthorityBusinessID,LocalAuthorityCode,LocalAuthorityName,Longitude,NewRatingPending,PostCode,RatingDate,RatingKey,RatingValue,RightToReply,SchemeType,Structural',
    '72 Regent Street,,Cambridge,Cambridgeshire,1,1472964,@72.China,Restaurant/Cafe/Canteen,5,5,52.2003982,9200874,027,Cambridge City,0.1261394,False,CB2 1DP,2026-03-24,fhrs_4_en-GB,4,"Owner says: SECRET COMMENT",FHRS,10',
    '108 Cherry Hinton Road,,Cambridge,Cambridgeshire,4613,1888757,108 cherry hinton mini market,Retailers - other,0,5,52.1882912,9214382,027,Cambridge City,0.1417569,True,CB1 7AJ,2024-12-17,fhrs_4_en-GB,4,,FHRS,10',
    ',,,,7846,1622001,Mobile Munch,Mobile caterer,,,,9210001,027,Cambridge City,,False,,,fhrs_awaitinginspection_en-GB,AwaitingInspection,,FHRS,',
    '1 High Street,,Edinburgh,,1,700001,Haggis House,Restaurant/Cafe/Canteen,,,55.95,ED1,760,Edinburgh (City of),-3.19,False,EH1 1AA,2026-08-01,fhis_pass_en-GB,Pass,,FHIS,',
    '9 Low Lane,,Leeds,West Yorkshire,7844,1999999,Dodgy Kebab,Takeaway/sandwich shop,30,20,53.8,LD9,406,Leeds,-1.55,False,LS1 4AB,2026-09-01,fhrs_1_en-GB,1,,FHRS,15',
    ',,,,1,,No Id Business,Restaurant/Cafe/Canteen,5,5,,X,027,Cambridge City,,False,CB1 1AA,2026-01-01,fhrs_5_en-GB,5,,FHRS,5',
  ].join('\r\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-food-hygiene', () => {
  it('streams the national CSV, normalizes, and drops the free-text reply column', async () => {
    stubOrigins({ fhrs: () => new Response(CSV, { headers: { 'content-type': 'text/xml' } }) });
    await load();
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('SECRET COMMENT');
    expect(text).not.toContain('RightToReply');
    const body = JSON.parse(text) as SuccessEnvelope<UkFoodHygieneRecord[]>;
    // The row without an FHRSID is skipped.
    expect(body.data).toHaveLength(5);
    expect(body.data[0]).toEqual({
      fhrs_id: 1472964,
      business_name: '@72.China',
      business_type: 'Restaurant/Cafe/Canteen',
      address: '72 Regent Street, Cambridge, Cambridgeshire',
      postcode: 'CB2 1DP',
      outward_code: 'CB2',
      local_authority: 'Cambridge City',
      local_authority_code: '027',
      rating_value: '4',
      scheme_type: 'FHRS',
      rating_date: '2026-03-24',
      hygiene_score: 5,
      structural_score: 10,
      confidence_score: 5,
      new_rating_pending: false,
      latitude: 52.2003982,
      longitude: 0.1261394,
    });
    const mobile = body.data.find((r) => r.fhrs_id === 1622001);
    expect(mobile).toMatchObject({
      address: null,
      postcode: null,
      outward_code: null,
      rating_value: 'AwaitingInspection',
      rating_date: null,
      hygiene_score: null,
      latitude: null,
    });
    const fhis = body.data.find((r) => r.scheme_type === 'FHIS');
    expect(fhis?.rating_value).toBe('Pass');
  });

  it('filters by rating, area, date, sub-score ceilings and the pending flag', async () => {
    stubOrigins({ fhrs: () => new Response(CSV) });
    await load();
    const { key } = await issueKey();
    const names = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkFoodHygieneRecord[]
      >;
      return body.data.map((r) => r.business_name);
    };
    expect(await names('rating_value=1')).toEqual(['Dodgy Kebab']);
    expect(await names('outward_code=cb1')).toEqual(['108 cherry hinton mini market']);
    expect(await names('local_authority=cambridge&rating_date_after=2026-01-01')).toEqual([
      '@72.China',
    ]);
    expect(await names('hygiene_score_min=10')).toEqual(['Dodgy Kebab']);
    expect(await names('new_rating_pending=true')).toEqual(['108 cherry hinton mini market']);
    expect(await names('q=haggis')).toEqual(['Haggis House']);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ fhrs: () => new Response('nope', { status: 503 }) });
    await load();
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkFoodHygieneRecord[]>;
    expect(body.meta?.total).toBe(30);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${URL_}?rating_date_after=lastweek`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
