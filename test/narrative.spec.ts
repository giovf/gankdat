import { describe, expect, it } from 'vitest';
import {
  facetNarrative,
  groupSentences,
  longDate,
  monthName,
  siblingLinks,
  sourceNarrative,
  trendSentences,
  wordCount,
} from '../src/lib/narrative';
import type { FacetPage, FacetStats, SourceStats } from '../src/lib/stats';

// gankdat `stats-page-content-depth` (2026-11-05): the day-30 IndexNow read found the engines
// crawling the facet pages and declining them as thin. Every page's summary must be ≥ 150 words,
// dated, and unique to the page — computed from its own numbers, never boilerplate alone.

const page = (
  value: string,
  label: string,
  total: number,
  extra: Partial<FacetPage> = {},
): FacetPage => ({
  value,
  label,
  total,
  monthly: null,
  groups: [],
  ...extra,
});

const facet: FacetStats = {
  segment: 'class',
  field: 'classes',
  title: 'By Nice class',
  pages: [
    page('01', 'Chemicals', 0),
    page('09', 'Scientific and electrical apparatus', 1_240, {
      monthly: {
        title: 'Applications published by month',
        buckets: [
          { month: '2026-08', count: 300 },
          { month: '2026-09', count: 410 },
          { month: '2026-10', count: 390 },
          { month: '2026-11', count: 140 },
        ],
      },
      groups: [
        {
          title: 'Applications published per weekly journal issue',
          rows: [
            { value: '2026/041', count: 90 },
            { value: '2026/042', count: 110 },
            { value: '2026/043', count: 95 },
            { value: '2026/044', count: 70 },
          ],
        },
        {
          title: 'UK filings vs international designations',
          rows: [
            { value: 'uk', count: 900 },
            { value: 'international', count: 340 },
          ],
        },
        {
          title: 'By applicant country',
          rows: [
            { value: 'GB', count: 700 },
            { value: 'US', count: 200 },
            { value: 'CN', count: 120 },
          ],
        },
        {
          title: 'Organisations with most applications',
          rows: [{ value: 'Acme Ltd', count: 12 }],
        },
      ],
    }),
    page('10', 'Medical apparatus', 310),
    page('25', 'Clothing and footwear', 980),
    page('35', 'Advertising and business services', 2_100),
    page('41', 'Education and entertainment', 1_500),
    page('42', 'Scientific and technological services', 1_900),
  ],
};

const input = (value: string): Parameters<typeof facetNarrative>[0] => ({
  sourceTitle: 'UK trade mark applications (Trade Marks Journal)',
  noun: 'trade mark applications',
  refreshedAt: '2026-11-05T06:05:00.000Z',
  parentTotal: 8_030,
  facet,
  page: facet.pages.find((p) => p.value === value)!,
});

describe('narrative helpers', () => {
  it('names months and dates in words', () => {
    expect(monthName('2026-11')).toBe('November 2026');
    expect(monthName('weird')).toBe('weird');
    expect(longDate('2026-11-05T06:05:00.000Z')).toBe('5 November 2026');
    expect(longDate(null)).toBe('the latest daily refresh');
  });

  it('counts words the way a thin-content check would', () => {
    expect(wordCount('As of 5 November 2026, 1,240 records — 12.3% of 8,030.')).toBe(10);
    expect(wordCount('')).toBe(0);
  });

  it('describes the month-to-month movement, marking the refresh month as partial', () => {
    const [head, spread] = trendSentences(
      facet.pages[1]!.monthly,
      '2026-11-05T06:05:00.000Z',
      'trade mark applications in class 09',
    );
    expect(head).toBe(
      'In November 2026 so far, 140 trade mark applications in class 09 have been published, down 250 (64.1%) on the 390 of October 2026.',
    );
    expect(spread).toContain('the busiest was September 2026 with 410');
    expect(spread).toContain('quietest November 2026 with 140');
    // A refresh in a later month reads the last bucket as a full month.
    expect(trendSentences(facet.pages[1]!.monthly, '2026-12-02T06:05:00.000Z', 'x')[0]).toContain(
      'In November 2026, the last full month in view, 140 x were published',
    );
    expect(trendSentences(null, null, 'rows')[0]).toContain('No dated rows');
  });

  it('writes the leaders of a top-N table and the latest rows of a chronological one', () => {
    const sentences = groupSentences(facet.pages[1]!.groups, 1_240, 'trade mark applications');
    expect(sentences[0]).toBe(
      'Looking at applications published per weekly journal issue, the latest, 2026/044, carried 70 trade mark applications and the one before it, 2026/043, 95; the busiest of the 4 in view was 2026/042 with 110.',
    );
    expect(sentences[1]).toBe(
      'Looking at UK filings vs international designations, uk leads with 900 trade mark applications (72.6% of the total), followed by international (340).',
    );
    expect(sentences[2]).toContain('GB leads with 700');
    expect(sentences[2]).toContain('followed by US (200) and CN (120).');
    expect(sentences[3]).toContain(
      'Acme Ltd leads with 12 trade mark applications (1.0% of the total) and is the only value present.',
    );
  });

  it('links the neighbours by value and the largest pages, each once, never the page itself', () => {
    const links = siblingLinks(facet, facet.pages[1]!);
    expect(links.map((l) => `${l.reason}:${l.value}`)).toEqual([
      'previous:01',
      'next:10',
      'largest:35',
      'largest:42',
      'largest:41',
      'largest:25',
    ]);
    // The first page has no previous neighbour; a page among the largest is not listed twice.
    expect(siblingLinks(facet, facet.pages[0]!).map((l) => l.value)).toEqual([
      '09',
      '35',
      '42',
      '41',
      '25',
    ]);
  });
});

describe('facetNarrative', () => {
  it('writes at least 150 dated words unique to the page from its own numbers', () => {
    const paragraphs = facetNarrative(input('09'));
    const text = paragraphs.join(' ');
    expect(wordCount(text)).toBeGreaterThanOrEqual(150);
    expect(paragraphs[0]).toBe(
      'As of 5 November 2026, UK trade mark applications (Trade Marks Journal) holds 1,240 trade mark applications in class 09 (Scientific and electrical apparatus) published between August 2026 and November 2026: 15.4% of the 8,030 trade mark applications in the dataset window, which makes it the 4th largest of the 7 class pages on this register.',
    );
    expect(text).toContain('In November 2026 so far, 140 trade mark applications in class 09');
    expect(text).toContain(
      'Next to it by number sit class 01 (Chemicals) with 0 and class 10 (Medical apparatus) with 310.',
    );
    expect(text).toContain(
      'The largest class pages on the register are class 35 (Advertising and business services, 2,100)',
    );
    expect(text).toContain(
      'A record counts in class 09 when its classes field matches 09, exactly as the API filter classes=09 selects it.',
    );
    // Unique to the page: another class's summary shares no paragraph with it.
    const other = facetNarrative(input('25'));
    expect(other.some((p) => paragraphs.includes(p))).toBe(false);
    expect(wordCount(other.join(' '))).toBeGreaterThanOrEqual(150);
  });

  it('still writes 150 dated words for a class with no records in the window', () => {
    const paragraphs = facetNarrative(input('01'));
    expect(paragraphs[0]).toContain(
      'As of 5 November 2026, none of the 8,030 trade mark applications',
    );
    expect(paragraphs[0]).toContain('class 01 (Chemicals)');
    expect(paragraphs.join(' ')).not.toContain('leads with');
    expect(wordCount(paragraphs.join(' '))).toBeGreaterThanOrEqual(150);
  });

  it('dates a page by its own refresh and reads "the latest daily refresh" without one', () => {
    expect(facetNarrative({ ...input('09'), refreshedAt: null })[0]).toContain(
      'As of the latest daily refresh,',
    );
  });
});

describe('sourceNarrative', () => {
  const stats: SourceStats = {
    total: 8_030,
    monthly: facet.pages[1]!.monthly,
    groups: facet.pages[1]!.groups.slice(1),
    changes: [
      { date: '2026-11-05', added: 120, removed: 90, changed: 3 },
      { date: '2026-11-04', added: 0, removed: 0, changed: 0 },
    ],
    facets: [facet],
  };

  it('writes the window, the month, the movers, the change feed and the largest facet pages', () => {
    const paragraphs = sourceNarrative({
      sourceTitle: 'UK trade mark applications (Trade Marks Journal)',
      noun: 'trade mark applications',
      refreshedAt: '2026-11-05T06:05:00.000Z',
      stats,
    });
    const text = paragraphs.join(' ');
    expect(paragraphs[0]).toBe(
      'As of 5 November 2026, UK trade mark applications (Trade Marks Journal) holds 8,030 trade mark applications in its current window, published between August 2026 and November 2026.',
    );
    expect(text).toContain(
      'Over the last 2 refresh days the register gained 120 trade mark applications, lost 90 and changed 3; the latest refresh, on 5 November 2026, added 120, removed 90 and changed 3.',
    );
    expect(text).toContain(
      'By class, the largest of the 7 pages are class 35 (Advertising and business services) with 2,100, class 42',
    );
    expect(text).toContain('1 class pages have no trade mark applications in the window.');
    expect(wordCount(text)).toBeGreaterThanOrEqual(150);
  });

  it('keeps to the dated headline for a source with no trend, breakdowns or facets', () => {
    const paragraphs = sourceNarrative({
      sourceTitle: 'X',
      noun: 'records',
      refreshedAt: null,
      stats: { total: 3, monthly: null, groups: [] },
    });
    expect(paragraphs[0]).toBe(
      'As of the latest daily refresh, X holds 3 records in its current window.',
    );
    expect(paragraphs[1]).toContain('No dated records');
  });
});
