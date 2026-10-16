import { describe, expect, it } from 'vitest';

import {
  bazaarClause,
  bazaarSummary,
  dailyRows,
  merchantResources,
  payToFromPaymentRequired,
  shouldProbe,
} from '../scripts/x402-bazaar-read';

const WALLET = '0x7284D41b5b852F2bd4c99bDf95043D84452d299C';
const BASE = 'https://gankdat.com';

const encode = (doc: unknown): string => btoa(JSON.stringify(doc));

describe('payToFromPaymentRequired', () => {
  it('reads the v2 PAYMENT-REQUIRED header first', () => {
    const header = encode({ x402Version: 2, accepts: [{ scheme: 'exact', payTo: WALLET }] });
    expect(payToFromPaymentRequired(header, { accepts: [{ payTo: '0x' + '1'.repeat(40) }] })).toBe(
      WALLET,
    );
  });

  it('falls back to a v1-shaped body and rejects anything that is not an EVM address', () => {
    expect(payToFromPaymentRequired(null, { accepts: [{ payTo: WALLET }] })).toBe(WALLET);
    expect(payToFromPaymentRequired('not-base64!', { accepts: [{ payTo: WALLET }] })).toBe(WALLET);
    expect(payToFromPaymentRequired(encode({ accepts: [{ payTo: 'bob' }] }), null)).toBeNull();
    expect(payToFromPaymentRequired(null, { error: 'payment_required' })).toBeNull();
  });
});

describe('merchantResources + bazaarSummary + bazaarClause', () => {
  const ours = (slug: string, calls: number, payers: number, at: string | null) => ({
    resource: `${BASE}/x402/data/${slug}`,
    quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: payers, lastCalledAt: at },
  });

  it('accepts `resources` (merchant) or `items` (discovery) and nothing else', () => {
    expect(merchantResources({ resources: [ours('a', 1, 1, null)] })).toHaveLength(1);
    expect(merchantResources({ items: [ours('a', 1, 1, null), null, 'x'] })).toHaveLength(1);
    expect(merchantResources({ resources: 'nope' })).toEqual([]);
    expect(merchantResources(null)).toEqual([]);
  });

  it('sums calls and payer-slots over our resources only and keeps the latest call date', () => {
    const summary = bazaarSummary(
      [
        ours('uk-tenders', 40, 3, '2026-10-20T10:00:00.000Z'),
        ours('uk-sanctions', 12, 2, '2026-10-25T01:02:03.000Z'),
        ours('uk-companies', 0, 0, null),
        {
          resource: 'https://other.example/x402/data/uk-tenders',
          quality: { l30DaysTotalCalls: 999 },
        },
        { resource: 'https://GANKDAT.com/x402/data/upper', quality: { l30DaysTotalCalls: 1.9 } },
        { quality: { l30DaysTotalCalls: 5 } },
      ],
      `${BASE}/`,
    );
    expect(summary).toEqual({ listed: 4, calls: 53, payers: 5, last: '2026-10-25' });
    expect(bazaarClause(summary)).toBe('bazaar: 4 listed, 53 calls/30d, 5 payers, last 2026-10-25');
  });

  it('reads `0 listed` until the catalogue indexes us, and `never` with no call yet', () => {
    expect(bazaarClause(bazaarSummary([], BASE))).toBe('bazaar: 0 listed');
    expect(bazaarClause(bazaarSummary([ours('a', 0, 0, null)], BASE))).toBe(
      'bazaar: 1 listed, 0 calls/30d, 0 payers, last never',
    );
  });
});

const row = (date: string, sales: string, notes: string): string =>
  `| ${date} | Daily numbers | 10 | — | ${sales} | ${notes} |`;

describe('shouldProbe', () => {
  const research = [
    '## Metrics',
    row('2026-10-14', '0 x402 paid', 'x402 validate: 17/17 valid; refresh ok'),
    row('2026-10-16', '0 x402 paid', 'bazaar: 0 listed; refresh ok'),
    row('2026-10-15', '0 x402 paid (+1 own probe)', 'bazaar: 0 listed; refresh ok'),
  ].join('\n');

  it('orders the rows newest first whatever the file order', () => {
    expect(dailyRows(research).map((r) => r.date)).toEqual([
      '2026-10-16',
      '2026-10-15',
      '2026-10-14',
    ]);
  });

  it('never pays without the key, always on a forced dispatch', () => {
    expect(shouldProbe({ hasKey: false, forced: true, today: '2026-10-17', research }).pay).toBe(
      false,
    );
    expect(shouldProbe({ hasKey: true, forced: true, today: '2026-10-17', research })).toEqual({
      pay: true,
      reason: 'forced by the workflow_dispatch input',
    });
  });

  it('waits 7 days after a probe or owner payment, then repeats while the clause reads 0 listed', () => {
    expect(shouldProbe({ hasKey: true, forced: false, today: '2026-10-22', research }).pay).toBe(
      false,
    );
    const later = shouldProbe({ hasKey: true, forced: false, today: '2026-10-23', research });
    expect(later.pay).toBe(true);
    expect(later.reason).toContain('bazaar: 0 listed');
  });

  it('does not pay once listed, on a failed read, or before any clause exists', () => {
    const listed =
      research +
      '\n' +
      row(
        '2026-10-24',
        '0 x402 paid',
        'bazaar: 17 listed, 0 calls/30d, 0 payers, last 2026-10-15; refresh ok',
      );
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-10-30', research: listed }).pay,
    ).toBe(false);
    const failed =
      research +
      '\n' +
      row('2026-10-24', '0 x402 paid', 'bazaar: n/a (merchant HTTP 500); refresh ok');
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-10-30', research: failed }).pay,
    ).toBe(false);
    const none = row('2026-10-14', '0 x402 paid', 'x402 validate: 17/17 valid');
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-10-20', research: none }),
    ).toEqual({
      pay: false,
      reason: 'no bazaar clause on any row yet (the owner makes the first call)',
    });
  });

  it('pays the monthly liveness call on the 1st unless a payment landed this week', () => {
    const listed =
      research +
      '\n' +
      row('2026-10-24', '0 x402 paid', 'bazaar: 17 listed, 0 calls/30d, 0 payers, last 2026-10-15');
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-11-01', research: listed }),
    ).toEqual({
      pay: true,
      reason: 'monthly liveness payment (1st of the month)',
    });
    const paid =
      listed +
      '\n' +
      row(
        '2026-10-28',
        '0 x402 paid (+1 own probe)',
        'bazaar: 17 listed, 1 calls/30d, 0 payers, last 2026-10-28',
      );
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-11-01', research: paid }).pay,
    ).toBe(false);
  });
});
