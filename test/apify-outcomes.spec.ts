import { describe, expect, it } from 'vitest';
import {
  byActorNote,
  failedCount,
  newlyFailing,
  previousFailed,
  type ActorOutcome,
} from '../src/lib/apify-outcomes';

// Apify run outcomes (2026-10-11): the per-actor suffix, the previous-row baseline and the rule
// that only a RISING failed count lists an actor under refresh errors.

const actors: ActorOutcome[] = [
  { name: 'uk-food-hygiene-ratings', n: 16, total: 16, failed: 0 },
  { name: 'uk-no-website-leads', n: 11, total: 11, failed: 2 },
  { name: 'uk-companies-house-lookup-monitor', n: 0, total: 1, failed: 0 },
];

const ROW_BEFORE =
  '| 2026-10-10 | Daily numbers | 1 accts | — | 0 x402 paid | MCP 24h: 1; apify 30d by actor: uk-food-hygiene-ratings 16, uk-no-website-leads 11 (1 failed); 0: uk-companies-house-lookup-monitor; agent sign-up: 0 | ';
const ROW_TODAY =
  '| 2026-10-11 | Daily numbers | 1 accts | — | 0 x402 paid | apify 30d by actor: uk-no-website-leads 11 (9 failed); agent sign-up: 0 |';

describe('failedCount', () => {
  it('adds failed and timed-out runs, never aborted or succeeded ones', () => {
    expect(failedCount({ SUCCEEDED: 9, FAILED: 2, 'TIMED-OUT': 1, ABORTED: 4, TOTAL: 16 })).toBe(3);
    expect(failedCount(undefined)).toBe(0);
  });
});

describe('byActorNote', () => {
  it('keeps the existing shape and adds the suffix only where failures exist', () => {
    expect(byActorNote(actors, true)).toBe(
      'apify 30d by actor: uk-food-hygiene-ratings 16, uk-no-website-leads 11 (2 failed); 0: uk-companies-house-lookup-monitor',
    );
    expect(byActorNote([], false)).toBe('apify 30d by actor (all accounts): none');
  });
});

describe('previousFailed', () => {
  it("reads the row before today's, skipping today's own row", () => {
    const prev = previousFailed(`${ROW_BEFORE}\n${ROW_TODAY}\n`, '2026-10-11');
    expect(prev).toEqual(
      new Map([
        ['uk-food-hygiene-ratings', 0],
        ['uk-no-website-leads', 1],
      ]),
    );
  });

  it('is null when the previous row has no per-actor reading', () => {
    const noReading = '| 2026-10-10 | Daily numbers | 1 accts | — | 0 | apify: n/a; refresh ok |';
    expect(previousFailed(noReading, '2026-10-11')).toBeNull();
    expect(previousFailed('', '2026-10-11')).toBeNull();
  });
});

describe('newlyFailing', () => {
  it('lists an actor whose failed count rose, as a refresh errors entry the auto-filer can read', () => {
    const prev = previousFailed(ROW_BEFORE, '2026-10-11');
    expect(newlyFailing(actors, prev)).toEqual([
      {
        source_slug: 'apify-uk-no-website-leads',
        message: '1 new failed run(s) since the last row, 2 of 11 in 30 d',
      },
    ]);
  });

  it('flags nothing when counts hold or fall, and nothing without a baseline', () => {
    const held = new Map([['uk-no-website-leads', 2]]);
    expect(newlyFailing(actors, held)).toEqual([]);
    const fell = new Map([['uk-no-website-leads', 5]]);
    expect(newlyFailing(actors, fell)).toEqual([]);
    expect(newlyFailing(actors, null)).toEqual([]);
  });
});
