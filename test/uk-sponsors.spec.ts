import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ukSponsorsSource } from '../src/sources/uk-sponsors';
import type { UkSponsorsRecord } from '../src/sources/uk-sponsors';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-sponsors';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukSponsorsSource);
}

const CONTENT = {
  details: {
    attachments: [
      {
        title: 'Register of Worker and Temporary Worker licensed sponsors',
        content_type: 'text/csv',
        url: 'https://assets.publishing.service.gov.uk/media/abc123/SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-09-18.csv',
      },
    ],
  },
};

// Real layout (2026-09-18 file): untrimmed cells, one row per organisation × route.
const CSV = [
  'Organisation Name,Town/City,County,Type & Rating,Route',
  ' AaruvikA Limited,Edinburgh,,Worker (A rating),Skilled Worker',
  ' Asian African Foods Ltd , London  ,,Worker (A rating),Skilled Worker',
  'Big Bank plc,London,Greater London,Worker (A rating),Global Business Mobility: Senior or Specialist Worker',
  'Big Bank plc,London,Greater London,Worker (A rating),Skilled Worker',
  'New Branch Co,Leeds,West Yorkshire,Worker (UK Expansion Worker: Provisional ),Global Business Mobility: UK Expansion Worker',
  'Festival Ltd,Brighton,East Sussex,Temporary Worker (B rating),Creative Worker',
  'Premium Corp,Manchester,,Worker (A (Premium)),Skilled Worker',
  ',,,Worker (A rating),Skilled Worker',
].join('\r\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-sponsors', () => {
  it('resolves the current CSV via the GOV.UK content API, trims, and splits type/rating', async () => {
    const mock = stubOrigins({
      govukContent: () => Response.json(CONTENT),
      govukAsset: () => new Response(CSV, { headers: { 'content-type': 'text/csv' } }),
    });
    await load();
    const asset = mock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('assets.publishing.service.gov.uk'));
    expect(asset).toContain('2026-09-18.csv');
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkSponsorsRecord[]>;
    // The nameless row is skipped.
    expect(body.data).toHaveLength(7);
    expect(body.data[0]).toEqual({
      organisation: 'AaruvikA Limited',
      town: 'Edinburgh',
      county: null,
      sponsor_type: 'Worker',
      rating: 'A',
      route: 'Skilled Worker',
    });
    expect(body.data[1]?.town).toBe('London');
    expect(body.data.find((r) => r.organisation === 'New Branch Co')).toMatchObject({
      sponsor_type: 'Worker',
      rating: 'Provisional',
      route: 'Global Business Mobility: UK Expansion Worker',
    });
    expect(body.data.find((r) => r.organisation === 'Festival Ltd')).toMatchObject({
      sponsor_type: 'Temporary Worker',
      rating: 'B',
    });
    expect(body.data.find((r) => r.organisation === 'Premium Corp')?.rating).toBe('A (Premium)');
  });

  it('filters by organisation, route and rating', async () => {
    stubOrigins({
      govukContent: () => Response.json(CONTENT),
      govukAsset: () => new Response(CSV),
    });
    await load();
    const { key } = await issueKey();
    const orgs = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkSponsorsRecord[]
      >;
      return body.data.map((r) => r.organisation);
    };
    expect(await orgs('organisation=big bank')).toEqual(['Big Bank plc', 'Big Bank plc']);
    expect(await orgs('route=senior or specialist')).toEqual(['Big Bank plc']);
    expect(await orgs('rating=B')).toEqual(['Festival Ltd']);
    expect(await orgs('sponsor_type=temporary')).toEqual(['Festival Ltd']);
  });

  it('refuses an attachment on an unexpected host and falls back to fixtures', async () => {
    stubOrigins({
      govukContent: () =>
        Response.json({
          details: {
            attachments: [{ content_type: 'text/csv', url: 'https://evil.example/x.csv' }],
          },
        }),
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSponsorsRecord[]>;
    expect(body.meta?.total).toBe(30);
  });

  it('falls back to bundled fixtures when the content API fails', async () => {
    stubOrigins({ govukContent: () => new Response('nope', { status: 500 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkSponsorsRecord[]>;
    expect(body.meta?.total).toBe(30);
  });
});
