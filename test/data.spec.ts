import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { authedFetch } from './helpers/auth';

type SourceListing = {
  slug: string;
  title: string;
  supported_params: string[];
  credit_cost: number;
};

describe('GET /v1/data (sources listing)', () => {
  it('lists registered sources with their supported params', async () => {
    const res = await SELF.fetch('https://example.com/v1/data');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<SourceListing[]>;
    expect(body.data.map((s) => s.slug)).toEqual([
      'uk-planning',
      'uk-tenders',
      'uk-contract-awards',
      'uk-sanctions',
      'eu-ted',
      'sam-exclusions',
      'uk-insolvency',
      'uk-companies',
      'uk-food-hygiene',
      'uk-sponsors',
      'uk-charities',
      'uk-care-locations',
      'uk-schools',
      'nhs-ods',
      'uk-trademark-journal',
      'uk-gambling-operators',
      'uk-company-profiles',
    ]);
    const tenders = body.data.find((s) => s.slug === 'uk-tenders');
    expect(tenders?.supported_params).toEqual(
      expect.arrayContaining(['buyer', 'cpv_codes', 'value_amount_min', 'published_at_after', 'q']),
    );
    expect(tenders?.credit_cost).toBe(1);
  });
});

describe('GET /v1/data/:source', () => {
  it('rejects invalid query params before any origin fetch', async () => {
    const res = await authedFetch('https://example.com/v1/data/uk-planning?per_page=1000');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
    expect(body.error.details).toEqual([expect.objectContaining({ param: 'per_page' })]);
  });

  it('returns the 404 envelope for unknown sources', async () => {
    const res = await authedFetch('https://example.com/v1/data/uk-unicorns');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('uk-unicorns');
  });
});
