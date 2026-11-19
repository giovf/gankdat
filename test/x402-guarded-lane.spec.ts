import { describe, expect, it, vi } from 'vitest';
import { guardedLane, startedPerRequest } from '../src/x402/routes';

// gankdat x402-init-failure-answer (2026-11-18): a payment-server start-up failure is retried
// once and then answered as unavailable; a failure after the handler ran is never repeated.

const next = (): Promise<void> => Promise.resolve();

describe('guardedLane', () => {
  it('returns the middleware response untouched when nothing throws', async () => {
    const report = vi.fn();
    const response = new Response('terms', { status: 402 });
    expect(await guardedLane(() => Promise.resolve(response), next, report)).toEqual({ response });
    expect(report).not.toHaveBeenCalled();
  });

  it('tries a start-up failure once more and serves the second attempt', async () => {
    const report = vi.fn();
    const run = vi
      .fn<(n: () => Promise<void>) => Promise<Response | void>>()
      .mockRejectedValueOnce(new Error('no supported payment kinds'))
      .mockResolvedValueOnce(new Response('terms', { status: 402 }));
    const outcome = await guardedLane(run, next, report);
    expect('response' in outcome && outcome.response?.status).toBe(402);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toBe(1);
  });

  it('answers unavailable after the second start-up failure, reporting both', async () => {
    const report = vi.fn();
    const run = vi.fn(() => Promise.reject(new Error('facilitator 429')));
    expect(await guardedLane(run, next, report)).toEqual({ unavailable: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.map((call) => call[1] as number)).toEqual([1, 2]);
  });

  it('lets a failure after the handler ran through, without a second run', async () => {
    const report = vi.fn();
    const run = vi.fn(async (tracked: () => Promise<void>) => {
      await tracked();
      throw new Error('settle failed');
    });
    await expect(guardedLane(run, next, report)).rejects.toThrow('settle failed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  // Live 2026-11-18 17:52–18:20: @x402/hono logs its start-up failure and RETURNS a 500, so the
  // throw-only guard let six of them through after it deployed.
  const failureOf = (response: Response): unknown =>
    response.status === 500 || response.status === 502
      ? new Error(`HTTP ${response.status}`)
      : null;

  it('retries a failure the middleware answered as a 500 response, then serves the second run', async () => {
    const report = vi.fn();
    const run = vi
      .fn<(n: () => Promise<void>) => Promise<Response | void>>()
      .mockResolvedValueOnce(Response.json({ error: 'Internal Server Error' }, { status: 500 }))
      .mockResolvedValueOnce(new Response('terms', { status: 402 }));
    const outcome = await guardedLane(run, next, report, failureOf);
    expect('response' in outcome && outcome.response?.status).toBe(402);
    expect(run).toHaveBeenCalledTimes(2);
    expect((report.mock.calls[0]?.[0] as Error).message).toBe('HTTP 500');
  });

  it('answers unavailable when the middleware answers 500 or 502 twice', async () => {
    const report = vi.fn();
    const run = vi.fn(() => Promise.resolve(new Response('bad gateway', { status: 502 })));
    expect(await guardedLane(run, next, report, failureOf)).toEqual({ unavailable: true });
    expect(report.mock.calls.map((call) => call[1] as number)).toEqual([1, 2]);
  });

  it('never repeats a 500 answered after the handler was entered', async () => {
    const report = vi.fn();
    const run = vi.fn(async (tracked: () => Promise<void>) => {
      await tracked();
      return new Response('handler failed after a verified payment', { status: 500 });
    });
    const outcome = await guardedLane(run, next, report, failureOf);
    expect('response' in outcome && outcome.response?.status).toBe(500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
});

// gankdat x402-init-failure-cause-read (2026-11-19): the live message was workerd's "This promise
// was created by a request that has since ended, so it can never settle" — the library's one
// start-up promise, made in the first request and awaited by all. Each request now runs its own.
describe('startedPerRequest', () => {
  it("never makes a second request wait on the first request's start", async () => {
    let calls = 0;
    // The first caller's start never settles, as when its request ended; the second's does.
    const start = vi.fn((): Promise<void> => {
      calls += 1;
      return calls === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
    });
    const started = startedPerRequest(start);
    void started();
    await expect(started()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stops calling start after the first success', async () => {
    const start = vi.fn(() => Promise.resolve());
    const started = startedPerRequest(start);
    await started();
    await started();
    await started();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed start', async () => {
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Facilitator getSupported failed (503)'))
      .mockResolvedValueOnce();
    const started = startedPerRequest(start);
    await expect(started()).rejects.toThrow('getSupported failed');
    await expect(started()).resolves.toBeUndefined();
    await started();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
