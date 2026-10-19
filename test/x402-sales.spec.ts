import { describe, expect, it } from 'vitest';

import {
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
});

describe('x402Paid30dNote and x402CallsBySlug', () => {
  it('renders the 30-day note and the per-slug map for the datasets reading', () => {
    expect(x402Paid30dNote(rows)).toBe(
      'x402 30d: 3 paid, 3 clients — uk-sanctions 2, eu-ted 1; python-requests 2, x402-fetch 1',
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
});
