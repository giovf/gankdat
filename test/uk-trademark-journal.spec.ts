import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import {
  DOWNLOADS_PER_RUN,
  DOWNLOAD_BUDGET_MS,
  ISSUE_FILES,
  journalClock,
  addMonths,
  candidateIssues,
  decodeEntities,
  isoDate,
  organisationName,
  parseIssue,
  ukTrademarkJournalSource,
} from '../src/sources/uk-trademark-journal';
import type { UkTrademarkJournalRecord } from '../src/sources/uk-trademark-journal';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-trademark-journal';
const YEAR = new Date().getUTCFullYear();
const id = (n: number, year = YEAR): string => `${year}-${String(n).padStart(3, '0')}`;

function load(): Promise<unknown> {
  return refreshD1Source(env, ukTrademarkJournalSource);
}

/** A plain (sizes-in-header) ZIP with one deflated entry. */
async function zipOf(name: string, text: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  const deflated = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
  const entryName = new TextEncoder().encode(name);
  const header = new Uint8Array(30);
  const v = new DataView(header.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(8, 8, true);
  v.setUint32(18, deflated.length, true);
  v.setUint32(22, raw.length, true);
  v.setUint16(26, entryName.length, true);
  const trailer = new Uint8Array(64).fill(0x50);
  const out = new Uint8Array(30 + entryName.length + deflated.length + trailer.length);
  out.set(header, 0);
  out.set(entryName, 30);
  out.set(deflated, 30 + entryName.length);
  out.set(trailer, 30 + entryName.length + deflated.length);
  return out;
}

interface Mark {
  number: string;
  text?: string;
  type?: string;
  classes: { n: number; goods: string }[];
  applicant: string;
  country?: string;
  representative?: string;
  filed?: string;
  priority?: string;
  ir?: string;
  series?: number;
  image?: boolean;
}

function markXml(m: Mark): string {
  const classes = m.classes
    .map(
      (c) =>
        `<Class><ClassNumber>${c.n}</ClassNumber><GoodsServicesDescription>${c.goods}</GoodsServicesDescription></Class>`,
    )
    .join('');
  const image = m.image
    ? `<MarkImage><![CDATA[${'iVBORw0KGgo='.repeat(20_000)}]]></MarkImage>`
    : '';
  return `<TradeMark>
    <ApplicationNumber>${m.number}</ApplicationNumber>
    ${m.text === undefined ? '' : `<MarkText>${m.text}</MarkText>`}
    ${m.type === undefined ? '' : `<MarkType>${m.type}</MarkType>`}
    ${image}
    <FilingDate>${m.filed ?? '2026-06-02'}</FilingDate>
    ${m.priority === undefined ? '' : `<PriorityDate>${m.priority}</PriorityDate>`}
    ${m.ir === undefined ? '' : `<InternationalRegistrationNumber>${m.ir}</InternationalRegistrationNumber>`}
    ${m.series === undefined ? '' : `<SeriesCount>${m.series}</SeriesCount>`}
    <Classes>${classes}</Classes>
    <Applicant>
      <Name>${m.applicant}</Name>
      <Address><Street>1 Example Street</Street><Town>Exampleton</Town><Country>${m.country ?? 'GB'}</Country></Address>
    </Applicant>
    ${m.representative === undefined ? '' : `<Representative><Name>${m.representative}</Name><Address><Country>GB</Country></Address></Representative>`}
  </TradeMark>`;
}

/** One journal issue in the layout the source assumes (LAYOUT in the source). */
function issueXml(number: string, date: string, marks: Mark[], extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE TradeMarksJournal>
<!-- weekly issue -->
<TradeMarksJournal xmlns="urn:ipo:tmj">
  <Header><JournalNumber>${number}</JournalNumber><PublicationDate>${date}</PublicationDate></Header>
  <Applications>
    ${marks.map(markXml).join('\n')}
  </Applications>
  ${extra}
</TradeMarksJournal>`;
}

const ISSUE_38 = issueXml(
  '2026/038',
  '18 September 2026',
  [
    {
      number: 'UK00004348816',
      text: 'NORTHWIND &amp; CO',
      type: 'Word',
      classes: [
        { n: 9, goods: 'Computer software; downloadable software for data analysis.' },
        { n: 35, goods: 'Business data analysis.' },
        { n: 42, goods: 'Software as a service.' },
      ],
      applicant: 'Northwind Analytics Ltd',
      representative: 'Example IP LLP',
      filed: '02/06/2026',
    },
    {
      number: 'UK00004348817',
      type: 'Figurative',
      classes: [{ n: 25, goods: 'Clothing; footwear; headgear.' }],
      applicant: 'Jane Example',
      image: true,
      filed: '20260520',
    },
    {
      number: 'WO0000001900003',
      text: 'KAFFEEHAUS BERG',
      type: 'Word',
      classes: [
        { n: 30, goods: 'Coffee; tea.' },
        { n: 43, goods: 'Caf&#233; services.' },
      ],
      applicant: 'Berg Kaffee GmbH',
      country: 'DE',
      representative: 'John Example',
      ir: '1900003',
      priority: '2025-12-01',
    },
    {
      number: 'UK00004348818',
      text: 'HARBOURSIDE',
      classes: [{ n: 36, goods: 'Real estate services.' }],
      applicant: 'Harbourside Developments PLC',
      series: 2,
    },
  ],
  // Sections the dataset does not cover, plus a record with no class (skipped).
  `<Withdrawals>${markXml({ number: 'UK00004348000', text: 'GONE', classes: [{ n: 1, goods: 'x' }], applicant: 'Gone Ltd' })}</Withdrawals>
   <Registrations>${markXml({ number: 'UK00004347999', text: 'DONE', classes: [{ n: 1, goods: 'x' }], applicant: 'Done Ltd' })}</Registrations>
   <Applications><TradeMark><ApplicationNumber>UK00004348819</ApplicationNumber><MarkText>NO CLASSES</MarkText></TradeMark></Applications>
   <InternationalRegistrations>${markXml({ number: 'WO0000001900004', text: 'VELOCITÀ', classes: [{ n: 12, goods: 'Bicycles.' }], applicant: 'Velocità S.r.l.', country: 'IT', ir: '1900004' })}</InternationalRegistrations>`,
);

const ISSUE_37 = issueXml('2026/037', '2026-09-11', [
  {
    number: 'UK00004299901',
    text: 'PIXELFORGE',
    type: 'Word',
    classes: [
      { n: 9, goods: 'Video game software.' },
      { n: 41, goods: 'Entertainment services.' },
    ],
    applicant: 'Pixelforge Studios Limited',
  },
  // Also published last week under the same number: kept once (newest issue wins).
  {
    number: 'UK00004348816',
    text: 'NORTHWIND (OLD)',
    classes: [{ n: 9, goods: 'x' }],
    applicant: 'Northwind Analytics Ltd',
  },
]);

function smallIssue(n: number): string {
  return issueXml(`${YEAR}/${String(n).padStart(3, '0')}`, '2026-01-02', [
    {
      number: `UK0000${String(4200000 + n).padStart(7, '0')}`,
      text: `MARK ${n}`,
      classes: [{ n: 1, goods: 'Chemicals.' }],
      applicant: `Issue ${n} Ltd`,
    },
  ]);
}

function issueOf(url: string): { id: string; file: string } {
  const m = /tm-journals\/(\d{4}-\d{3})\/([a-z.]+)$/.exec(url);
  return { id: m?.[1] ?? '', file: m?.[2] ?? '' };
}

/** Serves the given issues as jnl.xml (404 for jnl.zip and for every other issue). */
function serveIssues(
  issues: Record<string, string>,
  zipped: Record<string, Uint8Array> = {},
): ReturnType<typeof vi.fn> {
  return stubOrigins({
    ipoJournal: (url) => {
      const { id: issueId, file } = issueOf(url);
      if (file === 'jnl.zip') {
        const zip = zipped[issueId];
        return zip
          ? new Response(zip, { headers: { 'content-type': 'application/zip' } })
          : new Response('not found', { status: 404 });
      }
      const xml = issues[issueId];
      return xml
        ? new Response(xml, {
            headers: {
              'content-type': 'text/xml',
              'last-modified': 'Fri, 02 Jan 2026 06:00:00 GMT',
            },
          })
        : new Response('not found', { status: 404 });
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-trademark-journal', () => {
  it('ingests published applications from the newest issues, drops individuals and images, dedupes across issues', async () => {
    serveIssues({ [id(38)]: ISSUE_38, [id(37)]: ISSUE_37 });
    await load();
    const res = await authedFetch(`${URL_}?per_page=50`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('Jane Example');
    expect(text).not.toContain('John Example');
    expect(text).not.toContain('Example Street');
    expect(text).not.toContain('iVBORw0KGgo');
    expect(text).not.toContain('GONE');
    expect(text).not.toContain('DONE');
    expect(text).not.toContain('NO CLASSES');
    const body = JSON.parse(text) as SuccessEnvelope<UkTrademarkJournalRecord[]>;
    // 4 applications + 1 international registration in issue 38, 1 new one in issue 37
    expect(body.data).toHaveLength(6);
    expect(body.data.find((r) => r.application_number === 'UK00004348816')).toEqual({
      application_number: 'UK00004348816',
      journal_number: `${YEAR}/038`,
      publication_date: '2026-09-18',
      opposition_deadline: '2026-11-18',
      mark_text: 'NORTHWIND & CO',
      mark_type: 'Word',
      classes: '09,35,42',
      class_count: 3,
      goods_services:
        '09: Computer software; downloadable software for data analysis. | 35: Business data analysis. | 42: Software as a service.',
      applicant_type: 'organisation',
      applicant: 'Northwind Analytics Ltd',
      applicant_country: 'GB',
      representative: 'Example IP LLP',
      filing_date: '2026-06-02',
      priority_date: null,
      origin: 'UK application',
      international_registration: null,
      series_count: null,
      section: 'Applications',
      journal_url: `https://www.ipo.gov.uk/t-tmj/tm-journals/${id(38)}/UK00004348816.html`,
      register_url: 'https://trademarks.ipo.gov.uk/ipo-tmcase/page/Results/1/UK00004348816',
    });
    expect(body.data.find((r) => r.application_number === 'UK00004348817')).toMatchObject({
      mark_text: null,
      mark_type: 'Figurative',
      classes: '25',
      applicant_type: 'individual or unincorporated',
      applicant: null,
      applicant_country: 'GB',
      representative: null,
      filing_date: '2026-05-20',
    });
    expect(body.data.find((r) => r.application_number === 'WO0000001900003')).toMatchObject({
      origin: 'International registration designating the UK',
      international_registration: '1900003',
      applicant: 'Berg Kaffee GmbH',
      applicant_country: 'DE',
      representative: null, // a named individual
      priority_date: '2025-12-01',
      goods_services: '30: Coffee; tea. | 43: Café services.',
    });
    expect(body.data.find((r) => r.application_number === 'UK00004348818')?.series_count).toBe(2);
    expect(body.data.find((r) => r.application_number === 'WO0000001900004')).toMatchObject({
      section: 'InternationalRegistrations',
      applicant: 'Velocità S.r.l.',
    });
    expect(body.data.find((r) => r.application_number === 'UK00004299901')).toMatchObject({
      journal_number: `${YEAR}/037`,
      publication_date: '2026-09-11',
      opposition_deadline: '2026-11-11',
    });
  });

  it('filters by class, applicant, journal, origin and dates', async () => {
    serveIssues({ [id(38)]: ISSUE_38, [id(37)]: ISSUE_37 });
    await load();
    const { key } = await issueKey();
    const numbers = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkTrademarkJournalRecord[]
      >;
      return body.data.map((r) => r.application_number).sort();
    };
    expect(await numbers('classes=09')).toEqual(['UK00004299901', 'UK00004348816']);
    expect(await numbers('classes=42')).toEqual(['UK00004348816']);
    expect(await numbers('classes=41')).toEqual(['UK00004299901']);
    expect(await numbers('applicant=northwind')).toEqual(['UK00004348816']);
    expect(await numbers('applicant_type=individual')).toEqual(['UK00004348817']);
    expect(await numbers('applicant_country=DE')).toEqual(['WO0000001900003']);
    expect(await numbers('origin=international')).toEqual(['WO0000001900003', 'WO0000001900004']);
    expect(await numbers(`journal_number=${YEAR}/037`)).toEqual(['UK00004299901']);
    expect(await numbers('publication_date_after=2026-09-12')).toHaveLength(5);
    expect(await numbers('opposition_deadline_before=2026-11-11')).toEqual(['UK00004299901']);
    expect(await numbers('class_count_min=3')).toEqual(['UK00004348816']);
    expect(await numbers('q=harbourside')).toEqual(['UK00004348818']);
    expect(await numbers('mark_text=pixel')).toEqual(['UK00004299901']);
  });

  it('serves one weekly statistics page per Nice class, indexed from the dataset page', async () => {
    // Before any refresh: the listed page warms (503), never computes on request.
    expect(
      (await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/09')).status,
    ).toBe(503);
    serveIssues({ [id(38)]: ISSUE_38, [id(37)]: ISSUE_37 });
    await load();
    const parent = await (
      await SELF.fetch('https://example.com/stats/uk-trademark-journal')
    ).text();
    expect(parent).toContain('By Nice class (weekly pages)');
    expect(parent).toContain('href="/stats/uk-trademark-journal/class/09"');
    expect(parent).toContain('09 — Computers, software and electronics</a></td><td>2</td>');

    const res = await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/09');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class 09: Computers, software and electronics');
    expect(html).toContain('<tr><td>records in class 09</td><td>2</td></tr>');
    expect(html).toContain('<tr><td>share of the dataset</td><td>33.3%</td></tr>');
    expect(html).toContain('Applications published per weekly journal issue');
    expect(html).toContain(
      `<tr><td>${YEAR}/037</td><td>1</td></tr><tr><td>${YEAR}/038</td><td>1</td></tr>`,
    );
    expect(html).toContain('<tr><td>Northwind Analytics Ltd</td><td>1</td></tr>');
    expect(html).toContain('GET /v1/changes/uk-trademark-journal?classes=09&amp;since=YYYY-MM-DD');
    expect(html).toContain(
      '<link rel="canonical" href="https://gankdat.com/stats/uk-trademark-journal/class/09">',
    );
    expect(html).toContain('"isPartOf":"https://gankdat.com/stats/uk-trademark-journal"');
    expect(html).toContain(
      '"contentUrl":"https://gankdat.com/v1/data/uk-trademark-journal?classes=09"',
    );
    expect(html).not.toContain('Jane Example');

    // An empty class still has its page (the number IS the fact); unlisted values 404.
    const empty = await (
      await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/13')
    ).text();
    expect(empty).toContain('<tr><td>records in class 13</td><td>0</td></tr>');
    expect(
      (await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/99')).status,
    ).toBe(404);
    expect(
      (await SELF.fetch('https://example.com/stats/uk-trademark-journal/klass/09')).status,
    ).toBe(404);
    expect((await SELF.fetch('https://example.com/stats/uk-planning/class/09')).status).toBe(404);
  });

  it('filters the change feed by class, applicant and keyword — REST and the MCP get_changes tool', async () => {
    serveIssues({ [id(38)]: ISSUE_38, [id(37)]: ISSUE_37 });
    await load();
    vi.unstubAllGlobals();
    // Next week's issue: one software mark, one clothing mark.
    const ISSUE_39 = issueXml(`${YEAR}/039`, '2026-09-25', [
      {
        number: 'UK00004350001',
        text: 'CLOUDLOOM',
        type: 'Word',
        classes: [
          { n: 9, goods: 'Software.' },
          { n: 42, goods: 'SaaS.' },
        ],
        applicant: 'Cloudloom Systems Ltd',
        representative: 'Example IP LLP',
      },
      {
        number: 'UK00004350002',
        text: 'THREADBARE',
        classes: [{ n: 25, goods: 'Clothing.' }],
        applicant: 'Threadbare Apparel Limited',
      },
    ]);
    // The previous run remembered 039 as not yet published; a week has passed.
    await env.CACHE.delete(`tmj:missing:${id(39)}`);
    serveIssues({ [id(39)]: ISSUE_39 });
    await load();
    const { key } = await issueKey();
    const feed = 'https://example.com/v1/changes/uk-trademark-journal';
    const ids = async (qs: string): Promise<string[]> => {
      const res = await authedFetch(`${feed}?${qs}`, key);
      const text = await res.text();
      if (res.status !== 200) throw new Error(`${qs}: ${res.status} ${text}`);
      const body = JSON.parse(text) as SuccessEnvelope<{ record_id: string }[]>;
      return body.data.map((r) => r.record_id).sort();
    };
    expect(await ids('since=2026-01-01')).toEqual(['UK00004350001', 'UK00004350002']);
    expect(await ids('since=2026-01-01&classes=09')).toEqual(['UK00004350001']);
    expect(await ids('since=2026-01-01&classes=25&change=added')).toEqual(['UK00004350002']);
    expect(await ids('since=2026-01-01&q=threadbare')).toEqual(['UK00004350002']);
    expect(await ids('since=2026-01-01&applicant=cloudloom&representative=example')).toEqual([
      'UK00004350001',
    ]);
    expect(await ids('since=2026-01-01&applicant_country=DE')).toEqual([]);
    expect((await authedFetch(`${feed}?class=09`, key)).status).toBe(400);

    const rpc = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await SELF.fetch('https://example.com/mcp', {
        method: 'POST',
        headers: {
          ...bearer(key),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_changes', arguments: { source: 'uk-trademark-journal', ...args } },
        }),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text;
      return (JSON.parse(line.replace(/^data:\s*/, '')) as { result: Record<string, unknown> })
        .result;
    };
    const filtered = await rpc({ since: '2026-01-01', filter: { classes: '09', q: 'cloud' } });
    expect(filtered.isError).toBeUndefined();
    expect(
      (filtered.structuredContent as { data: { record_id: string }[] }).data.map(
        (r) => r.record_id,
      ),
    ).toEqual(['UK00004350001']);
    const bad = await rpc({ since: '2026-01-01', filter: { class: '09' } });
    expect(bad.isError).toBe(true);
  });

  it('caches each issue in KV so the next refresh downloads nothing already read', async () => {
    const mock = serveIssues({ [id(38)]: ISSUE_38, [id(37)]: ISSUE_37 });
    await load();
    const downloads = (m: ReturnType<typeof vi.fn>): string[] =>
      m.mock.calls
        .map((c) => issueOf(String(c[0])))
        .filter((u) => u.file === 'jnl.xml' && [id(38), id(37)].includes(u.id))
        .map((u) => u.id);
    expect(downloads(mock)).toEqual([id(38), id(37)]);
    vi.unstubAllGlobals();

    const again = serveIssues({});
    await load();
    expect(downloads(again)).toEqual([]);
    // Missing issue ids are remembered too: nothing above 038 is probed again.
    expect(again.mock.calls.length).toBe(0);
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(6);
  });

  it('tries every issue file in order and reads the zipped edition when present', async () => {
    const zip = await zipOf('jnl.xml', ISSUE_37);
    const mock = serveIssues({}, { [id(37)]: zip });
    await load();
    const files = mock.mock.calls
      .map((c) => issueOf(String(c[0])))
      .filter((u) => u.id === id(37))
      .map((u) => u.file);
    expect(files).toEqual([ISSUE_FILES[0]]);
    expect(ISSUE_FILES).toEqual(['jnl.zip', 'jnl.xml']);
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(2);
  });

  it('fills the window a few issues per run, newest first', async () => {
    const issues: Record<string, string> = {};
    for (let n = 1; n <= DOWNLOADS_PER_RUN + 2; n += 1) issues[id(n)] = smallIssue(n);
    serveIssues(issues);
    await load();
    let body = (await (await authedFetch(`${URL_}?per_page=50`)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(DOWNLOADS_PER_RUN);
    expect(body.data.map((r) => r.mark_text).sort()).toEqual(
      Array.from({ length: DOWNLOADS_PER_RUN }, (_, i) => `MARK ${i + 3}`).sort(),
    );
    await load();
    body = (await (await authedFetch(`${URL_}?per_page=50`)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(DOWNLOADS_PER_RUN + 2);
  });

  it('starts no new download once the run has spent its download budget, and resumes next run', async () => {
    const issues: Record<string, string> = {};
    for (let n = 1; n <= DOWNLOADS_PER_RUN + 1; n += 1) issues[id(n)] = smallIssue(n);
    const mock = serveIssues(issues);
    // The clock jumps past the budget as soon as one real issue has been fetched (its zip probe
    // and the xml read are two calls); probes of missing ids do not move it.
    journalClock.now = (): number =>
      mock.mock.calls.filter((c) => issueOf(String(c[0])).id in issues).length >= 2
        ? DOWNLOAD_BUDGET_MS
        : 0;
    try {
      await load();
    } finally {
      journalClock.now = (): number => Date.now();
    }
    let body = (await (await authedFetch(`${URL_}?per_page=50`)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(1);
    expect(body.data[0]?.mark_text).toBe(`MARK ${DOWNLOADS_PER_RUN + 1}`);
    await load();
    body = (await (await authedFetch(`${URL_}?per_page=50`)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(DOWNLOADS_PER_RUN + 1);
  });

  it('treats the IPO\'s 200 "Page Not Found" HTML as an unpublished issue, not a journal', async () => {
    // Relay tmj-stub-2026-10-07: jnl.xml of an unpublished issue answers 200 text/html (the
    // site's error page, last-modified 2020); every jnl.zip answers 403 text/html.
    const html =
      '<!DOCTYPE html><html><head><title>Intellectual Property Office - Page Not Found</title></head><body>Page Not Found</body></html>';
    stubOrigins({
      ipoJournal: (url) => {
        const { id: issueId, file } = issueOf(url);
        if (file === 'jnl.zip')
          return new Response(html, {
            status: 403,
            headers: { 'content-type': 'text/html; charset=UTF-8' },
          });
        if (issueId === id(37)) {
          return new Response(ISSUE_37, { headers: { 'content-type': 'application/xml' } });
        }
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(2);
    expect(await env.CACHE.get(`tmj:missing:${id(38)}`)).toBe('1');
    expect(await env.CACHE.get(`tmj:issue:${id(38)}`)).toBeNull();
  });

  it('fails loudly when an issue has no recognisable application, keeping the previous generation', async () => {
    serveIssues({ [id(37)]: ISSUE_37 });
    await load();
    vi.unstubAllGlobals();
    // The first run remembered 038 as not yet published; let that marker lapse.
    await env.CACHE.delete(`tmj:missing:${id(38)}`);

    serveIssues({
      [id(37)]: ISSUE_37,
      [id(38)]: '<?xml version="1.0"?><Journal><Issue><Item><Ref>1</Ref></Item></Issue></Journal>',
    });
    await expect(
      refreshD1Source({ ...env, FIXTURE_FALLBACK: 'false' }, ukTrademarkJournalSource),
    ).rejects.toThrow(
      `TMJ ${id(38)}: no published application recognised (0 candidate elements; element names seen: Journal, Issue, Item, Ref)`,
    );
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(2);
  });

  it('fails when no issue at all can be read, and falls back to fixtures only when configured', async () => {
    serveIssues({});
    await expect(
      refreshD1Source({ ...env, FIXTURE_FALLBACK: 'false' }, ukTrademarkJournalSource),
    ).rejects.toThrow('TMJ: no journal issue could be read');
    vi.unstubAllGlobals();

    serveIssues({});
    await load(); // the test environment enables the fixture fallback
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkTrademarkJournalRecord[]
    >;
    expect(body.meta?.total).toBe(10);
  });
});

describe('parseIssue', () => {
  const stream = (xml: string): ReadableStream<Uint8Array> =>
    new Blob([xml]).stream() as ReadableStream<Uint8Array>;

  it('reads attributes, nested class layouts, CDATA and split chunks', async () => {
    const xml = `<Journal><Number>2026/001</Number><DatePublished>02/01/2026</DatePublished>
      <Applications>
        <Application number="UK00004100001">
          <Mark><Text><![CDATA[A & B <C>]]></Text></Mark>
          <GoodsAndServices><Class number="9"><Description>Software.</Description></Class><Class number="42"><Description>SaaS.</Description></Class></GoodsAndServices>
          <ApplicantDetails><Applicant><FullName>Acme Widgets Inc</FullName><CountryCode>US</CountryCode></Applicant></ApplicantDetails>
        </Application>
      </Applications></Journal>`;
    // Feed the document in 7-byte chunks to exercise token and entity boundaries.
    const bytes = new TextEncoder().encode(xml);
    let offset = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset += 7;
      },
    });
    const issue = await parseIssue('2026-001', chunked, null);
    expect(issue.publication_date).toBe('2026-01-02');
    expect(issue.records).toHaveLength(1);
    expect(issue.records[0]).toMatchObject({
      application_number: 'UK00004100001',
      mark_text: 'A & B <C>',
      classes: '09,42',
      goods_services: '09: Software. | 42: SaaS.',
      applicant: 'Acme Widgets Inc',
      applicant_country: 'US',
      opposition_deadline: '2026-03-02',
    });
  });

  it('uses the file date when the issue carries none, and skips records without a number', async () => {
    const xml = `<Journal><Applications><TradeMark><MarkText>NO NUMBER</MarkText><ClassNumber>1</ClassNumber></TradeMark>
      <TradeMark><ApplicationNumber>UK00004100002</ApplicationNumber><Classes>9, 35</Classes></TradeMark></Applications></Journal>`;
    const issue = await parseIssue('2026-002', stream(xml), '2026-01-09');
    expect(issue.records.map((r) => r.application_number)).toEqual(['UK00004100002']);
    expect(issue.records[0]).toMatchObject({
      publication_date: '2026-01-09',
      opposition_deadline: '2026-03-09',
      classes: '09,35',
      goods_services: null,
      applicant_type: 'individual or unincorporated',
    });
  });

  it('rejects a file that is not XML', async () => {
    await expect(parseIssue('2026-003', stream('<' + 'x'.repeat(1_100_000)), null)).rejects.toThrow(
      'not well-formed XML',
    );
  });
});

describe('helpers', () => {
  it('lists candidate issues newest first over two years', () => {
    const ids = candidateIssues(new Date('2026-09-23T09:00:00Z'));
    expect(ids[0]).toBe('2026-053');
    expect(ids[52]).toBe('2026-001');
    expect(ids[53]).toBe('2025-053');
    expect(ids.at(-1)).toBe('2025-001');
  });

  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2026-09-18', 2)).toBe('2026-11-18');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('parses the date formats the journal and HTTP headers use', () => {
    expect(isoDate('2026-09-18')).toBe('2026-09-18');
    expect(isoDate('20260918')).toBe('2026-09-18');
    expect(isoDate('18/09/2026')).toBe('2026-09-18');
    expect(isoDate('18 September 2026')).toBe('2026-09-18');
    expect(isoDate('18 Sep 2026 06:00:00 GMT')).toBe('2026-09-18');
    expect(isoDate('soon')).toBeNull();
  });

  it('keeps only organisation names', () => {
    expect(organisationName('Northwind Analytics Ltd')).toBe('Northwind Analytics Ltd');
    expect(organisationName('BERG KAFFEE GMBH')).toBe('BERG KAFFEE GMBH');
    expect(organisationName('Velocità S.r.l.')).toBe('Velocità S.r.l.');
    expect(organisationName('The National Trust')).toBe('The National Trust');
    expect(organisationName('Jane Example')).toBeNull();
    expect(organisationName('  ')).toBeNull();
  });

  it('decodes entities', () => {
    expect(decodeEntities('A &amp; B &#233; &#xE9; &lt;x&gt; &unknown;')).toBe(
      'A & B é é <x> &unknown;',
    );
  });
});
