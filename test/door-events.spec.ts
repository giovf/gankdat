import { describe, expect, it } from 'vitest';
import { doorEventLine, doorEventsQueries, doorEventsReport } from '../src/lib/door-events';

// The event-by-event reading of the door (gankdat mcp-buy-attempt-read-2026-11-16): rows as
// Analytics Engine hands them over, rendered for the probe dispatch's job log.

describe('doorEventsQueries', () => {
  it('reads the three kinds of point and leaves the token refreshes out', () => {
    const [denied, signup, funnel] = doorEventsQueries(4);
    expect(denied).toContain(
      "INTERVAL '4' DAY AND blob1 = 'mcp_denied' AND blob4 = 'protected_tool'",
    );
    expect(signup).toContain("blob1 = 'mcp_anon' AND blob5 LIKE '%_api_key%'");
    expect(funnel).toContain("blob1 = 'oauth_funnel' AND blob5 != 'refresh_token'");
  });

  it('clamps the window', () => {
    expect(doorEventsQueries(-3)[0]).toContain("INTERVAL '1' DAY");
    expect(doorEventsQueries(5000)[0]).toContain("INTERVAL '90' DAY");
    expect(doorEventsQueries(Number.NaN)[0]).toContain("INTERVAL '7' DAY");
  });
});

describe('doorEventLine', () => {
  it('names the tool, the reason, the user agent and the short client id of a denied call', () => {
    expect(
      doorEventLine({
        ts: '2026-11-16 04:12:09',
        kind: 'mcp_denied',
        ua: 'agent-collector/0.1 (+capability survey; no payment)',
        step: 'tools/call',
        who: 'protected_tool',
        detail: 'buy_credits',
        client: '1a2b3c4d5e6f7a8b',
      }),
    ).toBe(
      '2026-11-16 04:12:09 | mcp_denied | buy_credits | protected_tool | agent-collector/0.1 (+capability survey; no payment) | client 1a2b3c4d',
    );
  });

  it('names the step, the client host and the detail of an OAuth leg', () => {
    expect(
      doorEventLine({
        ts: '2026-11-16 20:00:01',
        kind: 'oauth_funnel',
        ua: 'Mozilla/5.0 | x',
        step: 'signin_shown',
        who: 'claude.ai',
        detail: 'new',
        client: '',
      }),
    ).toBe('2026-11-16 20:00:01 | oauth | signin_shown | claude.ai | new | Mozilla/5.0 / x');
  });
});

describe('doorEventsReport', () => {
  it('says none when nothing happened', () => {
    expect(doorEventsReport([], 7)).toEqual(['door events 7d: none']);
  });

  it('prints oldest first under a head line', () => {
    const row = {
      kind: 'oauth_funnel',
      ua: null,
      step: 'authorize',
      who: '',
      detail: '',
      client: '',
    };
    const lines = doorEventsReport(
      [
        { ...row, ts: '2026-11-17 01:00:00' },
        { ...row, ts: '2026-11-16 23:00:00' },
      ],
      7,
    );
    expect(lines[0]).toBe('door events 7d: 2 point(s), oldest first');
    expect(lines[1]).toContain('2026-11-16 23:00:00 | oauth | authorize | (no client) | (no UA)');
    expect(lines[2]).toContain('2026-11-17 01:00:00');
  });
});
