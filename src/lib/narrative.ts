import type { FacetPage, FacetStats, MonthlyTrend, SourceStats, StatsGroup } from './stats';

// Dated written summaries for the /stats pages (gankdat `stats-page-content-depth`,
// 2026-11-05): the day-30 IndexNow read found Bing and Google crawling the facet pages
// (330 Bingbot fetches in 30 d) and declining them — a title, one sentence and two number
// tables read as thin. Every page now carries ≥ 150 words of prose computed from its own
// numbers: what moved this month, the top movers, the share of the parent and the
// neighbouring pages. Pure functions over the precomputed blob — nothing is read per request.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** 'YYYY-MM' → 'November 2026'; anything else is returned as given. */
export function monthName(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : ym;
}

/** ISO timestamp → '5 November 2026'; null → 'the latest daily refresh'. */
export function longDate(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : 'the latest daily refresh';
}

const n = (value: number): string => value.toLocaleString('en-GB');

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '—';

const ordinal = (rank: number): string => {
  const mod100 = rank % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : rank % 10 === 1
        ? 'st'
        : rank % 10 === 2
          ? 'nd'
          : rank % 10 === 3
            ? 'rd'
            : 'th';
  return `${rank}${suffix}`;
};

/** Words in a piece of prose, the way a search engine's thin-content check would count them. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The month-to-month movement: this month against last, the busiest and quietest months in view. */
export function trendSentences(
  monthly: MonthlyTrend | null,
  refreshedAt: string | null,
  subject: string,
): string[] {
  if (!monthly || monthly.buckets.length === 0) {
    return [
      `No dated ${subject} fall inside the current window, so there is no monthly trend to report yet.`,
    ];
  }
  const buckets = monthly.buckets;
  const latest = buckets[buckets.length - 1];
  if (!latest) return [];
  const previous = buckets.length > 1 ? buckets[buckets.length - 2] : undefined;
  const current = refreshedAt?.slice(0, 7) === latest.month;
  const out: string[] = [];
  const head = current
    ? `In ${monthName(latest.month)} so far, ${n(latest.count)} ${subject} have been published`
    : `In ${monthName(latest.month)}, the last full month in view, ${n(latest.count)} ${subject} were published`;
  if (previous) {
    const diff = latest.count - previous.count;
    const direction =
      diff === 0
        ? 'level with'
        : diff > 0
          ? `up ${n(diff)} (${pct(Math.abs(diff), previous.count)}) on`
          : `down ${n(-diff)} (${pct(Math.abs(diff), previous.count)}) on`;
    out.push(`${head}, ${direction} the ${n(previous.count)} of ${monthName(previous.month)}.`);
  } else {
    out.push(`${head}; ${monthName(latest.month)} is the only month in the window so far.`);
  }
  if (buckets.length > 2) {
    const sum = buckets.reduce((acc, b) => acc + b.count, 0);
    const busiest = buckets.reduce((a, b) => (b.count > a.count ? b : a));
    const quietest = buckets.reduce((a, b) => (b.count < a.count ? b : a));
    out.push(
      `Across the ${buckets.length} months in view the average is ${n(Math.round(sum / buckets.length))} a month; ` +
        `the busiest was ${monthName(busiest.month)} with ${n(busiest.count)} and the quietest ${monthName(quietest.month)} with ${n(quietest.count)}.`,
    );
  }
  return out;
}

/** One sentence per breakdown table: the leaders of a top-N table, the latest rows of a chronological one. */
export function groupSentences(groups: StatsGroup[], total: number, subject: string): string[] {
  const out: string[] = [];
  for (const group of groups) {
    const rows = group.rows;
    const first = rows[0];
    if (!first) continue;
    // Lower the opener for mid-sentence use, unless it is an acronym ("UK filings").
    const title = /^[A-Z][a-z]/.test(group.title)
      ? group.title.charAt(0).toLowerCase() + group.title.slice(1)
      : group.title;
    const chronological =
      rows.length > 1 && rows.every((r, i) => i === 0 || r.value >= (rows[i - 1]?.value ?? ''));
    const byCount =
      rows.length > 1 && rows.every((r, i) => i === 0 || r.count <= (rows[i - 1]?.count ?? 0));
    if (chronological && !byCount) {
      const latest = rows[rows.length - 1];
      const before = rows[rows.length - 2];
      const busiest = rows.reduce((a, b) => (b.count > a.count ? b : a));
      if (!latest || !before) continue;
      out.push(
        `Looking at ${title}, the latest, ${latest.value}, carried ${n(latest.count)} ${subject}` +
          ` and the one before it, ${before.value}, ${n(before.count)}; the busiest of the ${rows.length} in view was ${busiest.value} with ${n(busiest.count)}.`,
      );
      continue;
    }
    const rest = rows
      .slice(1, 3)
      .map((r) => `${r.value} (${n(r.count)})`)
      .join(' and ');
    out.push(
      `Looking at ${title}, ${first.value} leads with ${n(first.count)} ${subject} (${pct(first.count, total)} of the total)` +
        (rest
          ? `, followed by ${rest}.`
          : rows.length === 1
            ? ' and is the only value present.'
            : '.'),
    );
  }
  return out;
}

export interface FacetNarrativeInput {
  sourceTitle: string;
  /** What one record is, plural, e.g. 'trade mark applications'. */
  noun: string;
  refreshedAt: string | null;
  parentTotal: number;
  facet: FacetStats;
  page: FacetPage;
}

/** A sibling page named in the prose and linked from the page. */
export interface SiblingLink {
  value: string;
  label: string;
  total: number;
  /** Why it is listed: the page before or after this one by value, or one of the largest. */
  reason: 'previous' | 'next' | 'largest';
}

/** The neighbours by value and the largest pages of the facet, this page excluded; each value once. */
export function siblingLinks(facet: FacetStats, page: FacetPage, largest = 5): SiblingLink[] {
  const pages = facet.pages;
  const index = pages.findIndex((p) => p.value === page.value);
  const out: SiblingLink[] = [];
  const seen = new Set<string>([page.value]);
  const add = (p: FacetPage | undefined, reason: SiblingLink['reason']): void => {
    if (!p || seen.has(p.value)) return;
    seen.add(p.value);
    out.push({ value: p.value, label: p.label, total: p.total, reason });
  };
  if (index >= 0) {
    add(pages[index - 1], 'previous');
    add(pages[index + 1], 'next');
  }
  for (const p of [...pages]
    .sort((a, b) => b.total - a.total || a.value.localeCompare(b.value))
    .slice(0, largest)) {
    add(p, 'largest');
  }
  return out;
}

/** The facet page's summary: dated paragraphs computed from its own numbers, plain text (escape when rendering). */
export function facetNarrative(input: FacetNarrativeInput): string[] {
  const { sourceTitle, noun, refreshedAt, parentTotal, facet, page } = input;
  const name = `${facet.segment} ${page.value} (${page.label})`;
  const ranked = [...facet.pages].sort(
    (a, b) => b.total - a.total || a.value.localeCompare(b.value),
  );
  const rank = ranked.findIndex((p) => p.value === page.value) + 1;
  const months = page.monthly?.buckets ?? [];
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  const span =
    firstMonth && lastMonth && firstMonth.month !== lastMonth.month
      ? ` published between ${monthName(firstMonth.month)} and ${monthName(lastMonth.month)}`
      : '';
  const paragraphs: string[] = [];

  const headline =
    page.total === 0
      ? `As of ${longDate(refreshedAt)}, none of the ${n(parentTotal)} ${noun} in the current window of ${sourceTitle} fall in ${name}: ` +
        `the ${facet.segment} is empty for now, and this page will fill at the first daily refresh that finds one.`
      : `As of ${longDate(refreshedAt)}, ${sourceTitle} holds ${n(page.total)} ${noun} in ${name}${span}: ` +
        `${pct(page.total, parentTotal)} of the ${n(parentTotal)} ${noun} in the dataset window` +
        (rank > 0 && facet.pages.length > 1
          ? `, which makes it the ${ordinal(rank)} largest of the ${facet.pages.length} ${facet.segment} pages on this register.`
          : '.');
  paragraphs.push(headline);

  if (page.total > 0) {
    paragraphs.push(
      trendSentences(page.monthly, refreshedAt, `${noun} in ${facet.segment} ${page.value}`).join(
        ' ',
      ),
    );
    const movers = groupSentences(page.groups, page.total, noun);
    if (movers.length > 0) paragraphs.push(movers.join(' '));
  }

  const siblings = siblingLinks(facet, page);
  const neighbours = siblings.filter((s) => s.reason !== 'largest');
  const largest = siblings.filter((s) => s.reason === 'largest');
  const sentences: string[] = [];
  if (neighbours.length > 0) {
    sentences.push(
      `Next to it by number sit ${neighbours
        .map((s) => `${facet.segment} ${s.value} (${s.label}) with ${n(s.total)}`)
        .join(' and ')}.`,
    );
  }
  if (largest.length > 0) {
    sentences.push(
      `The largest ${facet.segment} pages on the register are ${largest
        .map((s) => `${facet.segment} ${s.value} (${s.label}, ${n(s.total)})`)
        .join(', ')}; each has its own page, trend and feed.`,
    );
  }
  if (sentences.length > 0) paragraphs.push(sentences.join(' '));

  paragraphs.push(
    `A record counts in ${facet.segment} ${page.value} when its ${facet.field} field matches ${page.value}, exactly as the API filter ${facet.field}=${page.value} selects it. ` +
      `The numbers cover the current window of the register, not all-time totals, and every table and sentence on this page is recomputed after each daily refresh of ${sourceTitle}, so a figure quoted with this page's URL and its date can be checked later.`,
  );
  return paragraphs;
}

export interface SourceNarrativeInput {
  sourceTitle: string;
  noun: string;
  refreshedAt: string | null;
  stats: SourceStats;
}

/** The parent page's summary: the window, what moved this month, the top movers and the largest facet pages. */
export function sourceNarrative(input: SourceNarrativeInput): string[] {
  const { sourceTitle, noun, refreshedAt, stats } = input;
  const months = stats.monthly?.buckets ?? [];
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  const span =
    firstMonth && lastMonth && firstMonth.month !== lastMonth.month
      ? `, published between ${monthName(firstMonth.month)} and ${monthName(lastMonth.month)}`
      : '';
  const paragraphs: string[] = [
    `As of ${longDate(refreshedAt)}, ${sourceTitle} holds ${n(stats.total)} ${noun} in its current window${span}.`,
  ];
  if (stats.total > 0) {
    paragraphs.push(trendSentences(stats.monthly, refreshedAt, noun).join(' '));
    const movers = groupSentences(stats.groups, stats.total, noun);
    if (movers.length > 0) paragraphs.push(movers.join(' '));
  }
  const changes = stats.changes ?? [];
  if (changes.length > 0) {
    const totals = changes.reduce(
      (acc, d) => ({
        added: acc.added + d.added,
        removed: acc.removed + d.removed,
        changed: acc.changed + d.changed,
      }),
      { added: 0, removed: 0, changed: 0 },
    );
    const latest = changes[0];
    if (latest) {
      paragraphs.push(
        `Over the last ${changes.length} refresh days the register gained ${n(totals.added)} ${noun}, lost ${n(totals.removed)} and changed ${n(totals.changed)}; ` +
          `the latest refresh, on ${longDate(latest.date)}, added ${n(latest.added)}, removed ${n(latest.removed)} and changed ${n(latest.changed)}.`,
      );
    }
  }
  for (const facet of stats.facets ?? []) {
    const ranked = [...facet.pages].sort(
      (a, b) => b.total - a.total || a.value.localeCompare(b.value),
    );
    const top = ranked.slice(0, 5).filter((p) => p.total > 0);
    const empty = facet.pages.filter((p) => p.total === 0).length;
    if (top.length === 0) continue;
    paragraphs.push(
      `By ${facet.segment}, the largest of the ${facet.pages.length} pages are ${top
        .map((p) => `${facet.segment} ${p.value} (${p.label}) with ${n(p.total)}`)
        .join(', ')}` +
        (empty > 0 ? `; ${n(empty)} ${facet.segment} pages have no ${noun} in the window.` : '.') +
        ` Each ${facet.segment} has its own page with the same trend, breakdowns and a keyless feed.`,
    );
  }
  return paragraphs;
}
