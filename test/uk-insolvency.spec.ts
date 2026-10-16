import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import fixtureEntries from '../src/sources/fixtures/uk-insolvency.json';
import { OriginUnavailableError, isOriginUnavailable } from '../src/sources/origin';
import { ukInsolvencySource } from '../src/sources/uk-insolvency';
import type { UkInsolvencyRecord } from '../src/sources/uk-insolvency';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const INSOLVENCY_URL = 'https://example.com/v1/data/uk-insolvency';

function feedResponse(entries: unknown[] = fixtureEntries): Response {
  return Response.json({ 'f:total': entries.length, entry: entries });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-insolvency', () => {
  it('normalizes entries to the whitelist and never serves person fields', async () => {
    const mock = stubOrigins({ gazette: feedResponse });
    const res = await authedFetch(INSOLVENCY_URL);
    expect(res.status).toBe(200);
    // 25 fixture entries < page size → a single origin request, no pagination.
    expect(mock).toHaveBeenCalledTimes(1);
    const text = await res.text();
    // Blind Mode: the feed's person fields and notice text must never appear.
    expect(text).not.toContain('familyName');
    expect(text).not.toContain('"content"');
    const body = JSON.parse(text) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(body.data).toHaveLength(25);
    expect(body.data[0]).toEqual({
      notice_id: '5172215',
      company: 'MCGAWLEY CONTRACTING LTD',
      notice_code: '2452',
      notice_type: 'Winding-Up Orders',
      published_at: '2026-07-12T16:10:07',
      updated_at: '2026-07-12T15:10:08Z',
      notice_url: 'https://www.thegazette.co.uk/notice/5172215',
    });
  });

  it('filters by company substring, notice code, and date range', async () => {
    stubOrigins({ gazette: feedResponse });
    const { key } = await issueKey();

    const byCompany = (await (
      await authedFetch(`${INSOLVENCY_URL}?company=mcgawley`, key)
    ).json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(byCompany.data.map((r) => r.notice_id)).toEqual(['5172215']);

    const petitions = (await (
      await authedFetch(`${INSOLVENCY_URL}?notice_code=2450`, key)
    ).json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(petitions.data.every((r) => r.notice_code === '2450')).toBe(true);
    expect(petitions.data.length).toBeGreaterThan(0);

    const none = (await (
      await authedFetch(`${INSOLVENCY_URL}?published_at_before=2000-01-01`, key)
    ).json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(none.data).toEqual([]);
  });

  it('retries a momentary 5xx and serves the origin data', async () => {
    let calls = 0;
    const mock = stubOrigins({
      gazette: () => {
        calls += 1;
        return calls === 1 ? new Response('gone fishing', { status: 500 }) : feedResponse();
      },
    });
    const res = await authedFetch(INSOLVENCY_URL);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    const body = (await res.json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(body.data).toHaveLength(25);
    expect(body.data[0]?.company).toBe('MCGAWLEY CONTRACTING LTD');
  });

  it('re-reads a page the origin cut (0 bytes with a content-length) and serves the origin data', async () => {
    // 2026-09-28 and 09-30: three reads in a row came back as 0 bytes while a runner got 204 KB.
    let calls = 0;
    const mock = stubOrigins({
      gazette: () => {
        calls += 1;
        return calls <= 2
          ? new Response('', { status: 200, headers: { 'content-length': '204426' } })
          : feedResponse();
      },
    });
    const res = await authedFetch(INSOLVENCY_URL);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(3);
    const body = (await res.json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(body.data).toHaveLength(25);
  });

  it('keeps the pages already read when a later page never arrives (partial snapshot, not a lost day)', async () => {
    // Page 1 is a full page (50 = PAGE_SIZE distinct notices), page 2 is cut on every read.
    const fullPage = Array.from({ length: 50 }, (_, i) => {
      const src = fixtureEntries[i % fixtureEntries.length] as Record<string, unknown>;
      return { ...src, id: `https://www.thegazette.co.uk/id/notice/${9000000 + i}` };
    });
    let calls = 0;
    const mock = stubOrigins({
      gazette: () => {
        calls += 1;
        return calls === 1 ? feedResponse(fullPage) : new Response('', { status: 200 });
      },
    });
    const res = await authedFetch(`${INSOLVENCY_URL}?per_page=100`);
    expect(res.status).toBe(200);
    // 1 good read + 4 cut reads of page 2, then the 50 records are served.
    expect(mock).toHaveBeenCalledTimes(5);
    const body = (await res.json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(body.meta?.total).toBe(50);
    expect(body.data).toHaveLength(50);
    expect(body.data[0]?.notice_id).toBe('9000000');
  });

  it('falls back to bundled fixtures when the origin keeps failing', async () => {
    const mock = stubOrigins({ gazette: () => new Response('gone fishing', { status: 500 }) });
    const res = await authedFetch(INSOLVENCY_URL);
    expect(res.status).toBe(200);
    // Four reads over ~13 s of growing fair-use pauses, like a cut body — 2026-10-10 13:00 the
    // runner read 503 twice 3 s apart and lost the day while the next run read the feed in full.
    expect(mock).toHaveBeenCalledTimes(4);
    const body = (await res.json()) as SuccessEnvelope<UkInsolvencyRecord[]>;
    expect(body.data).toHaveLength(25);
  });

  it('a 5xx that outlasts every read is the origin being unavailable, not a parser failure', async () => {
    // What the runner sees (prod and the runner pin FIXTURE_FALLBACK "false"): the typed error
    // the runner-side refresh turns into a `skipped` refresh_log row instead of `error`.
    const mock = stubOrigins({
      gazette: () => new Response('Service Unavailable', { status: 503 }),
    });
    const env = { FIXTURE_FALLBACK: 'false' } as unknown as CloudflareBindings;
    const failure = await ukInsolvencySource.fetchFresh(env).then(
      () => null,
      (err: unknown) => err,
    );
    expect(mock).toHaveBeenCalledTimes(4);
    expect(failure).toBeInstanceOf(OriginUnavailableError);
    expect(isOriginUnavailable(failure)).toBe(true);
    expect((failure as Error).message).toBe('thegazette.co.uk responded 503 after 4 reads');
    expect((failure as OriginUnavailableError).status).toBe(503);
  });

  it('a 4xx is a plain failure: never retried, never read as the origin being unavailable', async () => {
    const mock = stubOrigins({ gazette: () => new Response('Not Found', { status: 404 }) });
    const env = { FIXTURE_FALLBACK: 'false' } as unknown as CloudflareBindings;
    const failure = await ukInsolvencySource.fetchFresh(env).then(
      () => null,
      (err: unknown) => err,
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(isOriginUnavailable(failure)).toBe(false);
    expect((failure as Error).message).toBe('thegazette.co.uk responded 404');
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${INSOLVENCY_URL}?published_at_after=yesterday`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
