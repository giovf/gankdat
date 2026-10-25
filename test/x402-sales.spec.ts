import { describe, expect, it } from 'vitest';

import {
  isProberUa,
  splitX402Payers,
  uaFamily,
  x402CallsBySlug,
  x402Paid30dNote,
  x402PaidClause,
  x402Sales,
} from '../src/lib/x402-sales';

const rows = [
  { slug: 'uk-sanctions', ua: 'python-requests/2.34.2', client: 'c1', n: 1 },
  { slug: 'uk-sanctions', ua: 'python-requests/2.34.2', client: 'c2', n: 1 },
  { slug: 'eu-ted', ua: 'x402-fetch (node 22)', client: 'c3', n: '1' },
];

// The 10-24/25 shape: one named prober sweeping the unpaid routes over two days, a buyer that
// came back, a one-off buyer and a scout.
const sweep = (day: string, slugs: string[]) =>
  slugs.map((slug) => ({ slug, ua: 'lumiere-paycheck-prober/0.3', client: 'p1', day, n: 1 }));
const mixed = [
  ...sweep('2026-10-24', [
    'eu-ted',
    'nhs-ods',
    'sam-exclusions',
    'uk-care-locations',
    'uk-charities',
  ]),
  ...sweep('2026-10-25', ['uk-companies', 'uk-schools', 'uk-sponsors']),
  { slug: 'uk-tenders', ua: 'LumiTrustBuyer/1.0', client: 'b1', day: '2026-10-19', n: 1 },
  { slug: 'uk-tenders', ua: 'LumiTrustBuyer/1.0', client: 'b1', day: '2026-10-22', n: 2 },
  { slug: 'uk-tenders', ua: 'python-requests/2.34.2', client: 'b2', day: '2026-10-20', n: 1 },
  { slug: 'uk-tenders', ua: 'SettledScout/0.1', client: 's1', day: '2026-10-21', n: 1 },
];

describe('uaFamily', () => {
  it('keeps the product token and drops the row-breaking characters', () => {
    expect(uaFamily('python-requests/2.34.2')).toBe('python-requests');
    expect(uaFamily('x402-fetch (node 22)')).toBe('x402-fetch');
    expect(uaFamily('Mozilla/5.0 (X11; Linux)')).toBe('Mozilla');
    expect(uaFamily('weird|ua;(x)')).toBe('weirdua');
    expect(uaFamily('')).toBe('(no UA)');
    expect(uaFamily(null)).toBe('(no UA)');
  });
});

describe('isProberUa', () => {
  it('names the survey agents and nobody else', () => {
    for (const ua of [
      'lumiere-paycheck-prober/0.3',
      'SettledScout/0.1',
      'vet402-observatory-l1',
      'x402-survey (node)',
      'bazaar-collector/2',
      'Probe/1',
    ])
      expect(isProberUa(ua), ua).toBe(true);
    for (const ua of [
      'LumiTrustBuyer/1.0',
      'python-requests/2.34.2',
      'x402-fetch (node 22)',
      '',
      null,
    ])
      expect(isProberUa(ua), String(ua)).toBe(false);
  });
});

describe('x402Sales', () => {
  it('counts calls, distinct clients, slugs and families most first', () => {
    const s = x402Sales(rows);
    expect(s.paid).toBe(3);
    expect(s.clients).toBe(3);
    expect(s.bySlug).toEqual([
      ['uk-sanctions', 2],
      ['eu-ted', 1],
    ]);
    expect(s.byFamily).toEqual([
      ['python-requests', 2],
      ['x402-fetch', 1],
    ]);
  });

  it('does not count a client with an empty id or a zero row', () => {
    const s = x402Sales([
      { slug: 'eu-ted', ua: 'curl/8', client: '', n: 2 },
      { slug: 'eu-ted', ua: 'curl/8', client: 'c9', n: 0 },
    ]);
    expect(s.paid).toBe(2);
    expect(s.clients).toBe(0);
    expect(s.bySlug).toEqual([['eu-ted', 2]]);
  });
});

describe('splitX402Payers', () => {
  it('sets the named probers apart and counts the buyer that paid on two days as repeat', () => {
    const { buyers, probers } = splitX402Payers(mixed, 17);
    expect(buyers.paid).toBe(4);
    expect(buyers.clients).toBe(2);
    expect(buyers.repeat).toBe(1);
    expect(buyers.bySlug).toEqual([['uk-tenders', 4]]);
    expect(buyers.byFamily).toEqual([
      ['LumiTrustBuyer', 3],
      ['python-requests', 1],
    ]);
    expect(probers.paid).toBe(9);
    expect(probers.clients).toBe(2);
    expect(probers.byFamily).toEqual([
      ['lumiere-paycheck-prober', 8],
      ['SettledScout', 1],
    ]);
  });

  it('reads one client paying every route once in a day as a prober whatever its UA', () => {
    const day = '2026-10-20';
    const routes = ['a', 'b', 'c'];
    const sweepRows = routes.map((slug) => ({ slug, ua: 'curl/8', client: 'q1', day, n: 1 }));
    expect(splitX402Payers(sweepRows, 3).probers.paid).toBe(3);
    expect(splitX402Payers(sweepRows, 3).buyers.paid).toBe(0);
    // Fewer routes than the catalogue, or one route paid twice, is a buyer's day.
    expect(splitX402Payers(sweepRows, 4).buyers.paid).toBe(3);
    expect(
      splitX402Payers([...sweepRows, { slug: 'a', ua: 'curl/8', client: 'q1', day, n: 1 }], 3)
        .buyers.paid,
    ).toBe(4);
    // The same three routes over two days is not a sweep; an unread catalogue disables the rule.
    expect(
      splitX402Payers(
        sweepRows.map((r, i) => ({ ...r, day: i ? day : '2026-10-19' })),
        3,
      ).buyers.paid,
    ).toBe(3);
    expect(splitX402Payers(sweepRows, null).buyers.paid).toBe(3);
  });

  it('judges a row without a client id by its user agent and never counts it as a client', () => {
    const { buyers, probers } = splitX402Payers([
      { slug: 'eu-ted', ua: 'curl/8', client: '', n: 1 },
      { slug: 'eu-ted', ua: 'x402-survey/1', client: '', n: 2 },
    ]);
    expect(buyers).toMatchObject({ paid: 1, clients: 0, repeat: 0 });
    expect(probers).toMatchObject({ paid: 2, clients: 0 });
  });
});

describe('x402PaidClause', () => {
  it('names the sources, the client count and the UA families behind the 24-h count', () => {
    expect(x402PaidClause(3, rows)).toBe(
      '3 x402 paid (uk-sanctions 2, eu-ted 1; 3 clients; python-requests 2, x402-fetch 1)',
    );
  });

  it('stays the bare count when nothing sold, the grouped read failed, or the two reads disagree', () => {
    expect(x402PaidClause(0, rows)).toBe('0 x402 paid');
    expect(x402PaidClause(3, null)).toBe('3 x402 paid');
    expect(x402PaidClause(2, rows)).toBe('2 x402 paid');
    expect(x402PaidClause('1', [rows[2]!])).toBe('1 x402 paid (eu-ted 1; 1 client; x402-fetch 1)');
  });

  it('sets a prober apart from the buyers so a survey never reads as a sale', () => {
    const prober = { slug: 'nhs-ods', ua: 'lumiere-paycheck-prober/0.3', client: 'p1', n: 1 };
    expect(x402PaidClause(1, [prober])).toBe(
      '1 x402 paid (0 by buyers; probers 1: lumiere-paycheck-prober 1)',
    );
    expect(x402PaidClause(4, [...rows, prober])).toBe(
      '4 x402 paid (3 by buyers: uk-sanctions 2, eu-ted 1; 3 clients; python-requests 2, x402-fetch 1; probers 1: lumiere-paycheck-prober 1)',
    );
  });
});

describe('x402Paid30dNote and x402CallsBySlug', () => {
  it('renders the 30-day note and the per-slug map for the datasets reading', () => {
    expect(x402Paid30dNote(rows)).toBe(
      'x402 30d: 3 paid, 3 clients — buyers 3 paid, 3 clients, repeat 0 (uk-sanctions 2, eu-ted 1; python-requests 2, x402-fetch 1); probers 0',
    );
    expect(x402Paid30dNote([])).toBe('x402 30d: 0 paid');
    expect(x402Paid30dNote(null)).toBe('x402 30d: n/a');
    expect([...x402CallsBySlug(rows)]).toEqual([
      ['uk-sanctions', 2],
      ['eu-ted', 1],
    ]);
    expect(x402CallsBySlug([{ slug: '', ua: 'curl/8', client: 'c', n: 1 }]).size).toBe(0);
    expect(x402CallsBySlug(null).size).toBe(0);
  });

  it('splits buyers from probers in the note and keeps probers out of the datasets map', () => {
    expect(x402Paid30dNote(mixed, 17)).toBe(
      'x402 30d: 13 paid, 4 clients — buyers 4 paid, 2 clients, repeat 1 (uk-tenders 4; LumiTrustBuyer 3, python-requests 1); probers 9 paid, 2 clients (lumiere-paycheck-prober 8, SettledScout 1)',
    );
    expect(
      x402Paid30dNote([
        { slug: 'nhs-ods', ua: 'vet402-observatory-l1', client: 'o1', day: '2026-10-24', n: 1 },
      ]),
    ).toBe(
      'x402 30d: 1 paid, 1 client — buyers 0; probers 1 paid, 1 client (vet402-observatory-l1 1)',
    );
    expect([...x402CallsBySlug(mixed, 17)]).toEqual([['uk-tenders', 4]]);
  });
});
