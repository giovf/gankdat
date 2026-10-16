import { z } from 'zod';
import fixtureRecords from './fixtures/uk-trademark-journal.json';
import type { DataSource } from './types';
import { inflateZipEntry } from './zip';
import { originFetch } from './origin';

// UK Trade Marks Journal — the Intellectual Property Office's weekly list of
// trade mark applications (UK filings and international registrations
// designating the UK) accepted and published for opposition. Publication
// starts the two-month opposition window, which is why trade-mark watch
// services (£180–320 per mark per year) scan exactly this journal every week
// (exchange 2026-W39). OGL v3 (data.gov.uk record `ipo-tmj`); no key.
//
// Origin: one XML file per weekly issue, `…/t-tmj/tm-journals/<yyyy>-<nnn>/jnl.xml`
// (~145 MB with embedded mark images; the ZIP wrapper listed next to it is
// tried first). Issues are numbered per year, 001 upwards, one per Friday.
//
// Ingest: a rolling window of the newest 52 issues. Each issue is parsed once
// and its rows kept in KV (`tmj:issue:<id>`), so a refresh downloads only what
// is new; the D1 generation is rebuilt from the cached issues. The window
// fills over the first runs (DOWNLOADS_PER_RUN issues per refresh) so no
// single cron trigger downloads a year of journals. Issue ids that 404 get a
// short negative marker so the next number is probed again once published.
//
// The journal's XML schema is not documented and the origin was unreachable
// from the routine that wrote this (ALERTS.md handoff), so the reader is
// layout-tolerant: every schema assumption lives in LAYOUT below, records are
// recognised by their application number, and an issue with no recognisable
// record fails the refresh loudly with the element names it saw, keeping the
// previous generation.
//
// Data posture (Blind Mode): applicants are often private individuals, so an
// applicant or representative name is kept only when it carries a corporate
// designator (Ltd, plc, LLP, GmbH, …); otherwise the record says "individual
// or unincorporated" and carries no name. Addresses are reduced to the country.
// Mark images are never stored.

const ISSUE_BASE = 'https://www.ipo.gov.uk/t-tmj/tm-journals/';
const ISSUE_HOST = /(^|\.)ipo\.gov\.uk$/;
const USER_AGENT = 'gankdat.com data refresh';
/** Files tried per issue, in order. `jnl.xml` is the documented one; the zipped copy is preferred when present. */
export const ISSUE_FILES: readonly string[] = ['jnl.zip', 'jnl.xml'];
export const WINDOW_ISSUES = 52;
/** Newest issues downloaded per refresh (each ~145 MB inflated); the window fills over successive runs. */
export const DOWNLOADS_PER_RUN = 4;
/**
 * No new download starts once this much of the refresh has elapsed: the run of 2026-10-04 took
 * 13 min 42 s of wave 7's 15-minute Cron Trigger budget and the next two nights were killed
 * before writing a refresh_log row (queue `trademark-journal-silent-refresh`). What was cached
 * before the cut-off still streams into D1; the window keeps filling next run.
 */
export const DOWNLOAD_BUDGET_MS = 6 * 60_000;
/** Injectable clock for the download budget (tests drive it; production is Date.now). */
export const journalClock = { now: (): number => Date.now() };
/** Issue ids probed per year (the journal runs to 052 or 053). */
const ISSUES_PER_YEAR = 53;
/** Inflated cap per issue; the XML embeds mark images, hence the size. */
const MAX_BYTES = 400 * 1024 * 1024;
/** Longest run of text kept per element (mark images are base64 blobs far beyond this). */
const MAX_TEXT = 8_000;
/** Largest unfinished markup token tolerated before the file is declared not XML. */
const MAX_TOKEN = 1024 * 1024;
const GOODS_SERVICES_MAX = 1_000;
const ISSUE_CACHE_TTL = 400 * 86_400;
const MISSING_TTL_CURRENT_YEAR = 5 * 86_400;
const MISSING_TTL_PAST_YEAR = 60 * 86_400;
const OPPOSITION_MONTHS = 2;

/**
 * Every assumption about the journal XML, in one place. Names are matched
 * case-insensitively against element local names (and attribute names) at any
 * depth inside a record. Fix here once the live file has been read.
 */
export const LAYOUT = {
  /** Elements that hold one published application; the first name that matches, outermost, wins. */
  record: [
    'TradeMark',
    'Trademark',
    'Mark',
    'Application',
    'TradeMarkApplication',
    'Case',
    'Entry',
  ],
  /** Elements (outside records) carrying the issue number and date. */
  journalNumber: ['JournalNumber', 'JournalNo', 'PublicationIdentifier', 'IssueNumber'],
  publicationDate: [
    'PublicationDate',
    'DatePublished',
    'JournalDate',
    'PublishedDate',
    'IssueDate',
  ],
  /**
   * Ancestor names that mark a journal section the dataset does NOT cover
   * (the journal also lists withdrawals, completed registrations, renewals,
   * assignments, …). "InternationalRegistrations" is an accepted-for-opposition
   * section and stays in, hence the anchored registration patterns.
   */
  excludedSections:
    /withdraw|renew|assign|cancel|expir|correct|amend|licen|restor|surrender|remov|refus|lapse|division|conversion|proceeding|decision|^registrations?$|^registered|^marksregistered/i,
  applicationNumber: [
    'ApplicationNumber',
    'ApplicationNo',
    'MarkNumber',
    'TradeMarkNumber',
    'CaseNumber',
    'Number',
    'TMNumber',
  ],
  markText: [
    'MarkText',
    'MarkVerbalElementText',
    'WordMark',
    'Text',
    'MarkName',
    'Words',
    'MarkWords',
  ],
  markType: ['MarkType', 'MarkFeature', 'TypeOfMark', 'MarkCategory', 'Type'],
  filingDate: [
    'FilingDate',
    'ApplicationDate',
    'DateOfFiling',
    'DateFiled',
    'ApplicationFilingDate',
  ],
  priorityDate: ['PriorityDate', 'ClaimedPriorityDate'],
  internationalRegistration: [
    'InternationalRegistrationNumber',
    'IRNumber',
    'InternationalRegistration',
    'WIPONumber',
    'IRNo',
  ],
  classNumber: ['ClassNumber', 'NiceClass', 'ClassNo', 'Class'],
  goodsServices: [
    'GoodsServicesDescription',
    'GoodsAndServices',
    'GoodsServices',
    'Specification',
    'ClassDescription',
    'Description',
  ],
  applicant: ['Applicant', 'ApplicantDetails', 'Owner', 'Proprietor', 'Holder'],
  representative: ['Representative', 'RepresentativeDetails', 'Agent', 'Attorney'],
  partyName: ['OrganizationName', 'OrganisationName', 'FullName', 'Name', 'ApplicantName', 'Text'],
  partyCountry: ['Country', 'CountryCode', 'AddressCountry', 'ApplicantAddressCountryCode'],
  seriesCount: ['SeriesCount', 'NumberOfMarksInSeries', 'SeriesOf'],
} as const;

export const ukTrademarkJournalRecordSchema = z.object({
  /** IPO application number, e.g. "UK00004348816" (WO… for international registrations designating the UK) — stable. */
  application_number: z.string(),
  /** Journal issue that published the application, e.g. "2026/038". */
  journal_number: z.string(),
  /** Journal publication date (start of the opposition window). */
  publication_date: z.string().nullable(),
  /** Last day of the standard two-month opposition period (extendable to three by a TM7A). */
  opposition_deadline: z.string().nullable(),
  /** Verbal element of the mark; null for a purely figurative mark. */
  mark_text: z.string().nullable(),
  /** Mark type as published (Word, Figurative, 3D, Sound, …) when the journal states it. */
  mark_type: z.string().nullable(),
  /** Nice classes, zero-padded and comma-separated, e.g. "09,35,42" (filter with one two-digit class). */
  classes: z.string(),
  class_count: z.number(),
  /** Goods and services specification, capped at 1,000 characters. */
  goods_services: z.string().nullable(),
  /** "organisation" when the applicant name carries a corporate designator, else "individual or unincorporated". */
  applicant_type: z.string(),
  /** Applicant organisation name; null for individuals and unincorporated applicants (Blind Mode). */
  applicant: z.string().nullable(),
  applicant_country: z.string().nullable(),
  /** Representative firm; null when none, or when the representative is a named individual. */
  representative: z.string().nullable(),
  filing_date: z.string().nullable(),
  priority_date: z.string().nullable(),
  /** "UK application" or "International registration designating the UK". */
  origin: z.string(),
  international_registration: z.string().nullable(),
  /** Number of marks when the application is for a series; null otherwise. */
  series_count: z.number().nullable(),
  /** Journal section the record was published under, as named in the XML. */
  section: z.string().nullable(),
  /** The application's page in the journal issue. */
  journal_url: z.string(),
  /** The application on the IPO trade mark register. */
  register_url: z.string(),
});

export type UkTrademarkJournalRecord = z.infer<typeof ukTrademarkJournalRecordSchema>;

/* ------------------------------------------------------------------------ */
/* Minimal streaming XML reader                                              */
/* ------------------------------------------------------------------------ */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[localName(m[1]!)] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

export interface RecordEvent {
  node: XmlNode;
  /** Local names of the record's ancestors, outermost first. */
  ancestors: string[];
}

export interface ScanResult {
  /** Text of the first element outside any record whose name matches, per header key. */
  header: Record<string, string>;
  /** Distinct element names seen (first 40), for the loud-failure diagnostic. */
  names: string[];
  records: number;
}

/**
 * Streams an XML document and yields a tree for every element whose local
 * name is in `recordNames` (outermost match wins — nested matches stay inside
 * the record). Text outside records is discarded except for the header
 * elements requested. Text runs are capped so embedded images cost nothing.
 */
export async function* scanXml(
  body: ReadableStream<Uint8Array>,
  recordNames: readonly string[],
  headerNames: Record<string, readonly string[]>,
  result: ScanResult,
): AsyncGenerator<RecordEvent> {
  const isRecord = new Set(recordNames.map((n) => n.toLowerCase()));
  const headerLookup = new Map<string, string>();
  for (const [key, names] of Object.entries(headerNames)) {
    for (const name of names) {
      if (!headerLookup.has(name.toLowerCase())) headerLookup.set(name.toLowerCase(), key);
    }
  }
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const path: string[] = []; // local names of open elements outside/at the record boundary
  const stack: XmlNode[] = []; // open nodes inside the current record
  let record: XmlNode | null = null;
  let headerKey: string | null = null;
  let headerText = '';
  let headerDepth = 0;
  let buf = '';
  let done = false;
  const seenNames = new Set<string>();

  const appendText = (node: XmlNode, text: string): void => {
    if (node.text.length >= MAX_TEXT) return;
    node.text += text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  };

  const onText = (raw: string): void => {
    if (record) {
      const top = stack[stack.length - 1];
      if (!top || (top.text === '' && raw.trim() === '')) return;
      appendText(top, decodeEntities(raw));
    } else if (headerKey !== null && headerText.length < MAX_TEXT) {
      headerText += decodeEntities(raw);
    }
  };

  const onOpen = (name: string, attrs: Record<string, string>, selfClosing: boolean): void => {
    const lower = name.toLowerCase();
    if (seenNames.size < 40) seenNames.add(name);
    if (record) {
      const node: XmlNode = { name, attrs, text: '', children: [] };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      return;
    }
    if (isRecord.has(lower)) {
      record = { name, attrs, text: '', children: [] };
      if (selfClosing) {
        // Empty record element: nothing to yield.
        record = null;
        return;
      }
      stack.length = 0;
      stack.push(record);
      return;
    }
    if (!selfClosing) {
      path.push(name);
      if (headerKey === null) {
        const key = headerLookup.get(lower);
        if (key && !(key in result.header)) {
          headerKey = key;
          headerText = '';
          headerDepth = path.length;
        }
      }
    }
  };

  const pending: RecordEvent[] = [];
  const onClose = (): void => {
    if (record) {
      stack.pop();
      if (stack.length === 0) {
        pending.push({ node: record, ancestors: [...path] });
        record = null;
      }
      return;
    }
    if (headerKey !== null && path.length === headerDepth) {
      const text = headerText.replace(/\s+/g, ' ').trim();
      if (text !== '') result.header[headerKey] = text;
      headerKey = null;
    }
    path.pop();
  };

  let inCdata = false;
  /** Emits a text run, holding back a trailing entity that may continue in the next chunk. */
  const emitText = (text: string, final: boolean): string => {
    if (final) {
      onText(text);
      return '';
    }
    const amp = text.lastIndexOf('&');
    if (amp >= 0 && amp >= text.length - 10 && !text.includes(';', amp)) {
      onText(text.slice(0, amp));
      return text.slice(amp);
    }
    onText(text);
    return '';
  };

  const consume = (final: boolean): void => {
    for (;;) {
      if (inCdata) {
        const end = buf.indexOf(']]>');
        if (end < 0) {
          // Stream the block through (an embedded image can run to megabytes), keeping a 2-char tail.
          if (buf.length > 2) {
            onText(buf.slice(0, -2));
            buf = buf.slice(-2);
          }
          return;
        }
        onText(buf.slice(0, end));
        buf = buf.slice(end + 3);
        inCdata = false;
        continue;
      }
      const lt = buf.indexOf('<');
      if (lt < 0) {
        buf = emitText(buf, final);
        return;
      }
      if (lt > 0) {
        onText(buf.slice(0, lt));
        buf = buf.slice(lt);
      }
      let end: number;
      if (buf.startsWith('<![CDATA[')) {
        buf = buf.slice(9);
        inCdata = true;
        continue;
      }
      if (buf.startsWith('<!--')) {
        end = buf.indexOf('-->', 4);
        if (end < 0) break;
        buf = buf.slice(end + 3);
        continue;
      }
      if (buf.startsWith('<?')) {
        end = buf.indexOf('?>', 2);
        if (end < 0) break;
        buf = buf.slice(end + 2);
        continue;
      }
      if (buf.startsWith('<!')) {
        end = buf.indexOf('>', 2);
        if (end < 0) break;
        buf = buf.slice(end + 1);
        continue;
      }
      end = buf.indexOf('>', 1);
      if (end < 0) break;
      const tag = buf.slice(1, end);
      buf = buf.slice(end + 1);
      if (tag.startsWith('/')) {
        onClose();
        continue;
      }
      const selfClosing = tag.endsWith('/');
      const bodyText = selfClosing ? tag.slice(0, -1) : tag;
      const space = bodyText.search(/[\s]/);
      const name = localName(space < 0 ? bodyText : bodyText.slice(0, space));
      const attrs = space < 0 ? {} : parseAttrs(bodyText.slice(space + 1));
      onOpen(name, attrs, selfClosing);
    }
    // Unfinished markup token: wait for more input.
    if (buf.length > MAX_TOKEN) throw new Error('journal file is not well-formed XML');
  };

  try {
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) {
        buf += decoder.decode();
        done = true;
      } else {
        buf += decoder.decode(value, { stream: true });
      }
      consume(done);
      while (pending.length > 0) {
        result.records += 1;
        yield pending.shift()!;
      }
    }
  } finally {
    result.names = [...seenNames];
    await reader.cancel().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------ */
/* Record extraction                                                         */
/* ------------------------------------------------------------------------ */

function nameIn(node: XmlNode, names: readonly string[]): boolean {
  const lower = node.name.toLowerCase();
  return names.some((n) => n.toLowerCase() === lower);
}

/** Depth-first search for the first descendant (or self) with one of the names, in NAME priority order. */
export function findFirst(node: XmlNode, names: readonly string[]): XmlNode | null {
  for (const name of names) {
    const hit = findByName(node, name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function findByName(node: XmlNode, lower: string): XmlNode | null {
  if (node.name.toLowerCase() === lower) return node;
  for (const child of node.children) {
    const hit = findByName(child, lower);
    if (hit) return hit;
  }
  return null;
}

export function findAll(node: XmlNode, names: readonly string[]): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    if (nameIn(n, names)) {
      out.push(n);
      return; // do not descend into a match (a Class holds no nested Class)
    }
    for (const child of n.children) walk(child);
  };
  for (const child of node.children) walk(child);
  return out;
}

/** All text under a node, whitespace-normalised; empty → null. */
export function textOf(node: XmlNode | null): string | null {
  if (!node) return null;
  const parts: string[] = [];
  const walk = (n: XmlNode): void => {
    if (n.text !== '') parts.push(n.text);
    for (const child of n.children) walk(child);
  };
  walk(node);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Own text of a node only (no descendants), or the value of a like-named attribute. */
function ownText(node: XmlNode | null): string | null {
  if (!node) return null;
  const text = node.text.replace(/\s+/g, ' ').trim();
  if (text !== '') return text;
  const attr = Object.values(node.attrs).find((v) => v.trim() !== '');
  return attr === undefined ? null : attr.trim();
}

function firstText(node: XmlNode, names: readonly string[]): string | null {
  const hit = findFirst(node, names);
  return ownText(hit) ?? textOf(hit);
}

/** Attributes on the record or its direct children, keyed by lower-cased name. */
function attrText(node: XmlNode, names: readonly string[]): string | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const check = (n: XmlNode): string | null => {
    for (const [k, v] of Object.entries(n.attrs)) {
      if (wanted.has(k.toLowerCase()) && v.trim() !== '') return v.trim();
    }
    return null;
  };
  return check(node) ?? node.children.map(check).find((v) => v !== null) ?? null;
}

const APPLICATION_NUMBER = /\b((?:UK|WO)\d{11,13})\b/i;

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** Accepts ISO, YYYYMMDD, DD/MM/YYYY, DD-MM-YYYY and "18 September 2026"; else null. */
export function isoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month) return `${m[3]}-${month}-${m[1]!.padStart(2, '0')}`;
  }
  return null;
}

/** Same day-of-month N months on, clamped to the target month's length (Trade Marks Rules, r. 17). */
export function addMonths(iso: string, months: number): string {
  const [y, mo, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

const CORPORATE =
  /\b(ltd|limited|plc|llp|llc|inc|incorporated|corp|corporation|company|co|gmbh|ag|s\.?a\.?|s\.?r\.?l\.?|s\.?l\.?|s\.?p\.?a\.?|b\.?v\.?|n\.?v\.?|oy|ab|a\/s|as|aps|kk|k\.k\.|pty|pte|sdn bhd|bhd|group|holdings?|partners(hip)?|associates|association|foundation|trust|charity|university|college|school|council|authority|society|institute|club|federation|union|cooperative|co-operative|ltda|s\.?a\.?s\.?|sarl|s\.?à\.?r\.?l\.?|e\.?v\.?|kft|z\.?o\.?o\.?|d\.?o\.?o\.?|a\.?ş\.?|bv|nv|se|ug|ohg|kg|eurl|sasu|scrl|cvba|bvba|sprl|sl|sa|srl|spa|ltd\.|limited\.)\b\.?/i;

/** Blind Mode: an applicant or representative name is kept only when it reads as an organisation. */
export function organisationName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  return CORPORATE.test(trimmed) ? trimmed : null;
}

function padClass(raw: string): string | null {
  const m = /^\s*(?:class\s*)?(\d{1,2})\b/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 45) return null;
  return String(n).padStart(2, '0');
}

export interface JournalMeta {
  id: string; // "2026-038"
  number: string; // "2026/038"
  publicationDate: string | null;
}

function party(
  node: XmlNode,
  names: readonly string[],
): { name: string | null; raw: string | null; country: string | null } {
  const holder = findFirst(node, names);
  if (!holder) return { name: null, raw: null, country: null };
  const raw =
    firstText(holder, LAYOUT.partyName) ?? (holder.children.length === 0 ? ownText(holder) : null);
  const country = firstText(holder, LAYOUT.partyCountry);
  return { name: organisationName(raw), raw, country };
}

/** One published application → one record; null when the fragment carries no application number or classes. */
export function normalizeRecord(
  event: RecordEvent,
  journal: JournalMeta,
): UkTrademarkJournalRecord | null {
  const { node, ancestors } = event;
  const section = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;
  if (ancestors.some((a) => LAYOUT.excludedSections.test(a))) return null;

  const numberText =
    firstText(node, LAYOUT.applicationNumber) ?? attrText(node, LAYOUT.applicationNumber);
  let application = APPLICATION_NUMBER.exec(numberText ?? '')?.[1]?.toUpperCase() ?? null;
  if (application === null) {
    // Fall back to any application-shaped number anywhere in the record.
    const all = textOf(node) ?? '';
    application = APPLICATION_NUMBER.exec(all)?.[1]?.toUpperCase() ?? null;
  }
  if (application === null) return null;

  const classSet = new Set<string>();
  const goods: string[] = [];
  for (const cls of findAll(node, LAYOUT.classNumber)) {
    const own = ownText(cls);
    const padded =
      padClass(own ?? '') ??
      padClass(firstText(cls, ['ClassNumber', 'Number', 'No', 'Code', 'Id']) ?? '');
    if (padded) classSet.add(padded);
    const description = textOf(findFirst(cls, LAYOUT.goodsServices));
    if (description) goods.push(padded ? `${padded}: ${description}` : description);
  }
  if (classSet.size === 0) {
    // Class list as plain text ("9, 35, 42" or "Classes 09 35").
    const text = firstText(node, ['Classes', 'NiceClasses', 'ClassList']);
    for (const token of (text ?? '').split(/[^0-9]+/)) {
      const padded = padClass(token);
      if (padded) classSet.add(padded);
    }
  }
  if (goods.length === 0) {
    const spec = textOf(findFirst(node, LAYOUT.goodsServices));
    if (spec) goods.push(spec);
  }
  if (classSet.size === 0) return null;
  const classes = [...classSet].sort();

  const applicant = party(node, LAYOUT.applicant);
  const representative = party(node, LAYOUT.representative);
  const ir = firstText(node, LAYOUT.internationalRegistration);
  const isInternational = application.startsWith('WO') || (ir !== null && /\d{5,}/.test(ir));
  const markText = firstText(node, LAYOUT.markText);
  const markType = firstText(node, LAYOUT.markType) ?? attrText(node, LAYOUT.markType);
  const seriesRaw = firstText(node, LAYOUT.seriesCount);
  const series = seriesRaw === null ? Number.NaN : Number.parseInt(seriesRaw, 10);
  const spec = goods.join(' | ');
  const publication = journal.publicationDate;

  return {
    application_number: application,
    journal_number: journal.number,
    publication_date: publication,
    opposition_deadline: publication === null ? null : addMonths(publication, OPPOSITION_MONTHS),
    mark_text: markText,
    mark_type: markType,
    classes: classes.join(','),
    class_count: classes.length,
    goods_services: spec === '' ? null : spec.slice(0, GOODS_SERVICES_MAX),
    applicant_type: applicant.name === null ? 'individual or unincorporated' : 'organisation',
    applicant: applicant.name,
    applicant_country: applicant.country,
    representative: representative.name,
    filing_date: isoDate(firstText(node, LAYOUT.filingDate)),
    priority_date: isoDate(firstText(node, LAYOUT.priorityDate)),
    origin: isInternational ? 'International registration designating the UK' : 'UK application',
    international_registration: isInternational ? (ir ?? null) : null,
    series_count: Number.isFinite(series) && series > 1 ? series : null,
    section,
    journal_url: `${ISSUE_BASE}${journal.id}/${application}.html`,
    register_url: `https://trademarks.ipo.gov.uk/ipo-tmcase/page/Results/1/${application}`,
  };
}

/* ------------------------------------------------------------------------ */
/* Issues: enumeration, download, KV cache                                   */
/* ------------------------------------------------------------------------ */

interface CachedIssue {
  id: string;
  number: string;
  publication_date: string | null;
  fetched_at: string;
  records: UkTrademarkJournalRecord[];
}

const issueKey = (id: string): string => `tmj:issue:${id}`;
const missingKey = (id: string): string => `tmj:missing:${id}`;

/** Issue ids to consider, newest first: this year and last, 053 down to 001. */
export function candidateIssues(today: Date = new Date()): string[] {
  const year = today.getUTCFullYear();
  const out: string[] = [];
  for (const y of [year, year - 1]) {
    for (let n = ISSUES_PER_YEAR; n >= 1; n -= 1) out.push(`${y}-${String(n).padStart(3, '0')}`);
  }
  return out;
}

function journalNumberOf(id: string): string {
  return id.replace('-', '/');
}

async function fetchIssueFile(id: string, file: string): Promise<Response> {
  const url = new URL(`${ISSUE_BASE}${id}/${file}`);
  if (url.protocol !== 'https:' || !ISSUE_HOST.test(url.hostname)) {
    throw new Error(`journal file on unexpected host (${url.hostname})`);
  }
  let res = await originFetch(url.toString(), { headers: { 'user-agent': USER_AGENT } });
  for (let attempt = 1; res.status >= 500 && attempt <= 2; attempt += 1) {
    await new Promise((r) => setTimeout(r, 15_000 * attempt));
    res = await originFetch(url.toString(), { headers: { 'user-agent': USER_AGENT } });
  }
  return res;
}

/** Downloads and parses one issue; null when the issue does not exist (404 on every file). */
export async function fetchIssue(id: string): Promise<CachedIssue | null> {
  for (const file of ISSUE_FILES) {
    const res = await fetchIssueFile(id, file);
    if (res.status === 404 || res.status === 403 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    // The IPO answers an unpublished issue's jnl.xml with its "Page Not Found" HTML and status
    // 200 (relay `tmj-stub-2026-10-07`: 2026-042 and 2026-053, text/html, last-modified 2020),
    // and every jnl.zip with 403 text/html. An HTML body is a missing issue, not a journal.
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`TMJ ${id}/${file} download failed: ${res.status}`);
    const stream = file.endsWith('.zip') ? inflateZipEntry(res.body, MAX_BYTES) : res.body;
    const lastModified = isoDate(res.headers.get('last-modified')?.replace(/^\w+,\s*/, '') ?? null);
    return parseIssue(id, stream, lastModified);
  }
  return null;
}

export async function parseIssue(
  id: string,
  stream: ReadableStream<Uint8Array>,
  fallbackDate: string | null,
): Promise<CachedIssue> {
  const scan: ScanResult = { header: {}, names: [], records: 0 };
  const events: RecordEvent[] = [];
  for await (const event of scanXml(
    stream,
    LAYOUT.record,
    { number: LAYOUT.journalNumber, date: LAYOUT.publicationDate },
    scan,
  )) {
    events.push(event);
  }
  const journal: JournalMeta = {
    id,
    number: journalNumberOf(id),
    publicationDate: isoDate(scan.header['date'] ?? null) ?? fallbackDate,
  };
  const records: UkTrademarkJournalRecord[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const record = normalizeRecord(event, journal);
    if (record && !seen.has(record.application_number)) {
      seen.add(record.application_number);
      records.push(record);
    }
  }
  if (records.length === 0) {
    throw new Error(
      `TMJ ${id}: no published application recognised (${scan.records} candidate elements; element names seen: ${scan.names.join(', ') || 'none'})`,
    );
  }
  return {
    id,
    number: journal.number,
    publication_date: journal.publicationDate,
    fetched_at: new Date().toISOString(),
    records,
  };
}

async function cachedIssue(env: CloudflareBindings, id: string): Promise<CachedIssue | null> {
  return env.CACHE.get<CachedIssue>(issueKey(id), 'json');
}

async function* streamFromOrigin(
  env: CloudflareBindings,
): AsyncGenerator<UkTrademarkJournalRecord> {
  const today = new Date();
  const currentYear = String(today.getUTCFullYear());
  const startedAt = journalClock.now();
  let included = 0;
  let downloaded = 0;
  let budgetSpent = false;
  const seen = new Set<string>();
  const log = (event: string, extra: Record<string, unknown>): void => {
    console.log(JSON.stringify({ level: 'info', event, source: 'uk-trademark-journal', ...extra }));
  };
  for (const id of candidateIssues(today)) {
    if (included >= WINDOW_ISSUES) break;
    let issue = await cachedIssue(env, id);
    if (!issue) {
      if (await env.CACHE.get(missingKey(id))) continue;
      if (downloaded >= DOWNLOADS_PER_RUN) continue; // window keeps filling next run
      if (journalClock.now() - startedAt >= DOWNLOAD_BUDGET_MS) {
        budgetSpent = true;
        continue; // same: the cached issues still load, the rest waits for the next run
      }
      const fetched = await fetchIssue(id);
      if (!fetched) {
        const ttl = id.startsWith(currentYear) ? MISSING_TTL_CURRENT_YEAR : MISSING_TTL_PAST_YEAR;
        await env.CACHE.put(missingKey(id), '1', { expirationTtl: ttl });
        continue;
      }
      downloaded += 1;
      issue = fetched;
      await env.CACHE.put(issueKey(id), JSON.stringify(issue), { expirationTtl: ISSUE_CACHE_TTL });
      log('tmj_issue_loaded', {
        issue: id,
        records: issue.records.length,
        date: issue.publication_date,
        elapsed_ms: journalClock.now() - startedAt,
      });
    }
    included += 1;
    for (const record of issue.records) {
      if (seen.has(record.application_number)) continue;
      seen.add(record.application_number);
      yield record;
    }
  }
  log('tmj_window', {
    issues: included,
    downloaded,
    elapsed_ms: journalClock.now() - startedAt,
    download_budget_spent: budgetSpent,
  });
  if (included === 0) throw new Error('TMJ: no journal issue could be read');
}

function fixtures(): UkTrademarkJournalRecord[] {
  return z.array(ukTrademarkJournalRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkTrademarkJournalRecord> {
  let yielded = 0;
  try {
    for await (const record of streamFromOrigin(env)) {
      yielded += 1;
      yield record;
    }
  } catch (err) {
    if (yielded === 0 && String(env.FIXTURE_FALLBACK) === 'true') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'fixture_fallback',
          source: 'uk-trademark-journal',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

/**
 * The 45 Nice classes (Nice Classification, 12th edition headings, shortened):
 * one bounded /stats/uk-trademark-journal/class/<nn> page each — the
 * "trade mark applications this week class 9" search, and the watch a
 * business runs on the class it trades in. Values are the two-digit tokens of
 * the `classes` field, so `classes=09` selects the same records.
 */
export const NICE_CLASSES: readonly { value: string; label: string }[] = [
  ['01', 'Chemicals'],
  ['02', 'Paints and coatings'],
  ['03', 'Cosmetics and cleaning preparations'],
  ['04', 'Fuels, oils and lubricants'],
  ['05', 'Pharmaceuticals and medical preparations'],
  ['06', 'Common metals and metal goods'],
  ['07', 'Machines and machine tools'],
  ['08', 'Hand tools and cutlery'],
  ['09', 'Computers, software and electronics'],
  ['10', 'Medical and surgical apparatus'],
  ['11', 'Lighting, heating, cooking and sanitary apparatus'],
  ['12', 'Vehicles'],
  ['13', 'Firearms and fireworks'],
  ['14', 'Jewellery, watches and precious metals'],
  ['15', 'Musical instruments'],
  ['16', 'Paper goods, printed matter and stationery'],
  ['17', 'Rubber, plastics and insulating materials'],
  ['18', 'Leather goods, luggage and bags'],
  ['19', 'Non-metallic building materials'],
  ['20', 'Furniture and household furnishings'],
  ['21', 'Household utensils, glassware and cookware'],
  ['22', 'Ropes, nets, tents and raw textile fibres'],
  ['23', 'Yarns and threads'],
  ['24', 'Textiles and fabrics'],
  ['25', 'Clothing, footwear and headgear'],
  ['26', 'Lace, embroidery, buttons and haberdashery'],
  ['27', 'Carpets, rugs and wall hangings'],
  ['28', 'Games, toys and sporting goods'],
  ['29', 'Meat, fish, dairy and processed foods'],
  ['30', 'Coffee, tea, bakery goods and confectionery'],
  ['31', 'Agricultural produce, plants and live animals'],
  ['32', 'Beers and non-alcoholic drinks'],
  ['33', 'Alcoholic beverages'],
  ['34', 'Tobacco, vapes and smokers’ articles'],
  ['35', 'Advertising, business management and retail services'],
  ['36', 'Financial, insurance and real-estate services'],
  ['37', 'Construction, installation and repair services'],
  ['38', 'Telecommunications services'],
  ['39', 'Transport, packaging and storage services'],
  ['40', 'Treatment of materials and custom manufacturing'],
  ['41', 'Education, training, entertainment and sport'],
  ['42', 'Scientific, technological and software services'],
  ['43', 'Food, drink and accommodation services'],
  ['44', 'Medical, veterinary, beauty and agricultural services'],
  ['45', 'Legal, security and personal services'],
].map(([value, label]) => ({ value, label }));

export const ukTrademarkJournalSource: DataSource<UkTrademarkJournalRecord> = {
  slug: 'uk-trademark-journal',
  title: 'UK trade mark applications published for opposition (Trade Marks Journal)',
  description:
    'Every UK trade mark application and international registration designating the UK accepted and published in the Intellectual Property Office’s weekly Trade Marks Journal — application number, mark text and type, Nice classes and goods/services, applicant organisation and country, representative firm, filing and priority dates, journal issue, publication date and the two-month opposition deadline. Rolling 52 weekly issues (about a year); the change feed lists each week’s new publications. Applicant names are kept only for organisations; addresses reduced to country; mark images never stored.',
  storage: 'd1',
  stats: {
    date: { field: 'publication_date', title: 'Applications published by month' },
    groupBy: [
      { field: 'classes', title: 'Most-filed class combinations', limit: 12 },
      { field: 'applicant_type', title: 'By applicant type', limit: 2 },
      { field: 'origin', title: 'UK filings vs international designations', limit: 2 },
      { field: 'applicant_country', title: 'By applicant country', limit: 12 },
      { field: 'representative', title: 'Busiest representatives', limit: 15 },
    ],
    facets: [
      {
        segment: 'class',
        field: 'classes',
        title: 'By Nice class (weekly pages)',
        values: NICE_CLASSES,
        date: { field: 'publication_date', title: 'Applications published by month' },
        groupBy: [
          {
            field: 'journal_number',
            title: 'Applications published per weekly journal issue',
            limit: WINDOW_ISSUES,
            sort: 'value',
          },
          { field: 'origin', title: 'UK filings vs international designations', limit: 2 },
          { field: 'applicant_country', title: 'By applicant country', limit: 10 },
          { field: 'applicant', title: 'Organisations with most applications', limit: 10 },
          { field: 'representative', title: 'Busiest representatives', limit: 10 },
        ],
      },
    ],
  },
  recordSchema: ukTrademarkJournalRecordSchema,
  queryParams: z.object({
    application_number: z.string().optional(),
    journal_number: z.string().optional(),
    mark_text: z.string().optional(),
    mark_type: z.string().optional(),
    /** One two-digit Nice class, e.g. "09" or "35". */
    classes: z.string().optional(),
    class_count_min: z.coerce.number().optional(),
    class_count_max: z.coerce.number().optional(),
    goods_services: z.string().optional(),
    applicant: z.string().optional(),
    applicant_type: z.string().optional(),
    applicant_country: z.string().optional(),
    representative: z.string().optional(),
    origin: z.string().optional(),
    section: z.string().optional(),
    publication_date_after: z.iso.date().optional(),
    publication_date_before: z.iso.date().optional(),
    opposition_deadline_after: z.iso.date().optional(),
    opposition_deadline_before: z.iso.date().optional(),
    filing_date_after: z.iso.date().optional(),
    filing_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '5 6 * * *', cacheTtlSeconds: 86_400, wave: 7 },
  idOf: (r) => r.application_number,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkTrademarkJournalRecord[]> {
    const records: UkTrademarkJournalRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
