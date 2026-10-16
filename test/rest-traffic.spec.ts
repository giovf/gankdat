import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshD1Source } from '../src/sources/d1store';
import { ukCareLocationsSource } from '../src/sources/uk-care-locations';
import { authedFetch } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const HEADER =
  "Name,Also known as,Address,Postcode,Phone number,Service's website (if available),Service types,Date of latest check,Specialisms/services,Provider name,Local authority,Region,Location URL,CQC Location ID (for office use only),CQC Provider ID (for office use only)";
const PAGE = '<a href="https://www.cqc.org.uk/system/files/2026-09/x_CQC_directory.csv">csv</a>';
const CSV = [
  HEADER,
  `Alpha House,,"1 Road,Town",AB1 2CD,,,Care home,01/Jan/2024 - 00:00,Dementia,Prov Ltd,Leeds,Yorkshire & Humberside,https://www.cqc.org.uk/location/1-A,1-A,1-9`,
].join('\n');

async function load(): Promise<void> {
  stubOrigins({ cqcPage: () => new Response(PAGE), cqcFile: () => new Response(CSV) });
  await refreshD1Source(env, ukCareLocationsSource);
  vi.unstubAllGlobals();
}

afterEach(() => {
  vi.unstubAllGlobals();
  // vi.spyOn returns the SAME mock when the method is already spied, so without
  // this the third test sees the first two tests' calls and can never fail.
  vi.restoreAllMocks();
});

// The REST surface wrote no Analytics Engine data point at all, so STRATEGY §4's
// "change-feed calls / week" target was unreadable even while the routes were served.
describe('REST traffic analytics', () => {
  it('counts a served /v1/changes call as rest_changes with the source slug', async () => {
    await load();
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');

    const res = await authedFetch('https://example.com/v1/changes/uk-care-locations');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: [
          'rest_changes',
          expect.any(String),
          '/v1/changes/uk-care-locations',
          expect.stringMatching(/./), // the key's account id (datasets 30d external)
          'uk-care-locations',
        ],
        indexes: ['rest_changes'],
      }),
    );
  });

  it('counts a served /v1/data call as rest_data', async () => {
    await load();
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');

    const res = await authedFetch('https://example.com/v1/data/uk-care-locations');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: [
          'rest_data',
          expect.any(String),
          '/v1/data/uk-care-locations',
          expect.stringMatching(/./),
          'uk-care-locations',
        ],
        indexes: ['rest_data'],
      }),
    );
  });

  // A denial is not adoption: counting 401s would inflate the number the §4 target reads.
  it('does not count a keyless request', async () => {
    await load();
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');

    const res = await SELF.fetch('https://example.com/v1/changes/uk-care-locations');
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ indexes: ['rest_changes'] }));
  });
});
