import { describe, expect, it } from 'vitest';

import {
  PROBE_MONTHLY_CAP,
  bazaarClause,
  bazaarResourceLines,
  bazaarSummary,
  dailyRows,
  errorFromPaymentRequired,
  exampleQueryFromPaymentRequired,
  merchantResources,
  ownProbePayments,
  payToFromPaymentRequired,
  probeTargets,
  routeUrl,
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

describe('exampleQueryFromPaymentRequired + routeUrl + errorFromPaymentRequired', () => {
  it('reads the declared example query and builds the call the indexer makes', () => {
    const header = encode({
      x402Version: 2,
      accepts: [{ payTo: WALLET }],
      extensions: {
        bazaar: {
          info: {
            input: { type: 'http', queryParams: { company_number: '00000006', nested: {} } },
          },
        },
      },
    });
    expect(exampleQueryFromPaymentRequired(header)).toEqual({ company_number: '00000006' });
    expect(routeUrl(`${BASE}/`, 'uk-company-profiles', { company_number: '00000006' })).toBe(
      `${BASE}/x402/data/uk-company-profiles?company_number=00000006`,
    );
    expect(routeUrl(BASE, 'uk-tenders', null)).toBe(`${BASE}/x402/data/uk-tenders?per_page=1`);
    expect(exampleQueryFromPaymentRequired(encode({ extensions: { bazaar: {} } }))).toBeNull();
    expect(exampleQueryFromPaymentRequired(null)).toBeNull();
    expect(exampleQueryFromPaymentRequired('nope')).toBeNull();
  });

  it('reads the facilitator reason from a 402 to a signed payment', () => {
    expect(
      errorFromPaymentRequired(encode({ error: 'invalid_payment: description too long' })),
    ).toBe('invalid_payment: description too long');
    expect(errorFromPaymentRequired(encode({ error: '' }))).toBeNull();
    expect(errorFromPaymentRequired(null)).toBeNull();
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

describe('shouldProbe + ownProbePayments', () => {
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

  it('counts the half-cents the rows of the last 30 days record', () => {
    expect(ownProbePayments(research, '2026-10-20')).toBe(1);
    expect(ownProbePayments(research, '2026-11-20')).toBe(0);
    const more =
      research + '\n' + row('2026-10-24', '2 x402 paid (+16 own probe)', 'bazaar: 1 listed');
    expect(ownProbePayments(more, '2026-10-25')).toBe(17);
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

  it('waits 7 days after a probe or owner payment, then reads the catalogue', () => {
    expect(shouldProbe({ hasKey: true, forced: false, today: '2026-10-22', research }).pay).toBe(
      false,
    );
    const later = shouldProbe({ hasKey: true, forced: false, today: '2026-10-23', research });
    expect(later.pay).toBe(true);
    expect(later.reason).toContain('reading the catalogue');
    expect(later.reason).toContain(`1 of ${PROBE_MONTHLY_CAP}`);
  });

  it('stops at the 30-day cap, forced or not', () => {
    const capped =
      research +
      '\n' +
      row('2026-10-24', '0 x402 paid (+16 own probe)', 'bazaar: 1 listed') +
      '\n' +
      row('2026-10-31', '0 x402 paid (+3 own probe)', 'bazaar: 17 listed');
    expect(ownProbePayments(capped, '2026-11-08')).toBe(PROBE_MONTHLY_CAP);
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-11-08', research: capped }).reason,
    ).toContain('cap spent');
    expect(
      shouldProbe({ hasKey: true, forced: true, today: '2026-11-08', research: capped }).pay,
    ).toBe(false);
    // the 10-15 payment leaves the window on 11-15; the 10-24 one on 11-24
    expect(
      shouldProbe({ hasKey: true, forced: false, today: '2026-11-25', research: capped }).pay,
    ).toBe(true);
  });
});

describe('probeTargets', () => {
  const slugs = ['uk-tenders', 'uk-sanctions', 'eu-ted'];
  const listed = (slug: string, at: string | null) => ({
    resource: `${BASE}/x402/data/${slug}`,
    quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1, lastCalledAt: at },
  });

  it('pays every unlisted route and every listed route settled 23 days ago or never', () => {
    const targets = probeTargets({
      slugs,
      resources: [
        listed('uk-tenders', '2026-10-18T09:00:00Z'),
        listed('eu-ted', null),
        { resource: 'https://other.example/x402/data/uk-sanctions', quality: {} },
      ],
      base: `${BASE}/`,
      today: '2026-10-23',
      forced: false,
    });
    expect(targets).toEqual([
      {
        slug: 'uk-sanctions',
        url: `${BASE}/x402/data/uk-sanctions?per_page=1`,
        reason: 'unlisted',
      },
      { slug: 'eu-ted', url: `${BASE}/x402/data/eu-ted?per_page=1`, reason: 'never called' },
    ]);
    const stale = probeTargets({
      slugs: ['uk-tenders'],
      resources: [listed('uk-tenders', '2026-10-18T09:00:00Z')],
      base: BASE,
      today: '2026-11-10',
      forced: false,
    });
    expect(stale).toEqual([
      { slug: 'uk-tenders', url: `${BASE}/x402/data/uk-tenders?per_page=1`, reason: 'stale 23 d' },
    ]);
    expect(
      probeTargets({
        slugs: ['uk-tenders'],
        resources: [listed('UK-Tenders', '2026-11-01T00:00:00Z')],
        base: BASE,
        today: '2026-11-10',
        forced: false,
      }),
    ).toEqual([]);
  });

  it('pays every route on a forced run', () => {
    const targets = probeTargets({
      slugs,
      resources: [listed('uk-tenders', '2026-10-22T00:00:00Z')],
      base: BASE,
      today: '2026-10-23',
      forced: true,
    });
    expect(targets.map((t) => `${t.slug}:${t.reason}`)).toEqual([
      'uk-tenders:forced',
      'uk-sanctions:forced',
      'eu-ted:forced',
    ]);
  });
});

describe('bazaarResourceLines', () => {
  it('prints one line per resource of ours, most called first, and skips other sellers', () => {
    const lines = bazaarResourceLines(
      [
        { resource: `${BASE}/x402/data/eu-ted`, quality: { l30DaysTotalCalls: 1 } },
        {
          resource: `${BASE}/x402/data/uk-sanctions`,
          quality: {
            l30DaysTotalCalls: 3,
            l30DaysUniquePayers: 3,
            lastCalledAt: '2026-10-18T09:01:00Z',
          },
        },
        { resource: 'https://other.example/x402/data/x', quality: { l30DaysTotalCalls: 9 } },
      ],
      BASE,
    );
    expect(lines).toEqual([
      `bazaar resource: ${BASE}/x402/data/uk-sanctions calls 3 payers 3 last 2026-10-18`,
      `bazaar resource: ${BASE}/x402/data/eu-ted calls 1 payers 0 last never`,
    ]);
  });
});
