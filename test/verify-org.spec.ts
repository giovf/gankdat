import { describe, expect, it } from 'vitest';
import { lookupParams, pickCharity, sameName, verifyOrganisation } from '../src/lib/verify-org';
import type { FetchRecords } from '../src/lib/verify-org';

// The Zoho CRM verification card folds three register calls (gankdat
// `zoho-crm-uk-registers-widget`): the fold is tested here with a stub fetch, so the widget's
// only untested part is Zoho's own SDK glue.

const active = {
  company_number: '00000006',
  company: 'MARINE AND GENERAL MUTUAL LIFE ASSURANCE SOCIETY',
  status: 'active',
  status_detail: null,
  company_type: 'private-limited-guarant-nsc',
  incorporated_on: '1862-11-25',
  dissolved_on: null,
  accounts_overdue: false,
  confirmation_overdue: false,
  has_insolvency_history: false,
  has_been_liquidated: false,
  charges_outstanding: 0,
  registered_office_in_dispute: false,
  previous_names: [],
};

function stub(answers: Record<string, Record<string, unknown>[] | Error>): {
  fetch: FetchRecords;
  calls: [string, Record<string, string>][];
} {
  const calls: [string, Record<string, string>][] = [];
  const fetch: FetchRecords = (source, params) => {
    calls.push([source, params]);
    const a = answers[source];
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a ?? []);
  };
  return { fetch, calls };
}

describe('lookupParams and sameName', () => {
  it('prefers the number, falls back to the name, null when neither', () => {
    expect(lookupParams({ company_number: ' 00000006 ', name: 'X' })).toEqual({
      company_number: '00000006',
    });
    expect(lookupParams({ company_number: '', name: 'Acme Ltd' })).toEqual({ company: 'Acme Ltd' });
    expect(lookupParams({})).toBeNull();
  });
  it('ignores case, punctuation and the legal-form suffix', () => {
    expect(sameName('ACME WIDGETS LIMITED', 'Acme Widgets Ltd.')).toBe(true);
    expect(sameName('The Acme Trust', 'ACME TRUST')).toBe(true);
    expect(sameName('Acme Widgets', 'Acme Gadgets')).toBe(false);
    expect(sameName('', '')).toBe(false);
  });
});

describe('pickCharity', () => {
  const rows = [
    {
      registered_charity_number: 1,
      name: 'ACME TRUST',
      registration_status: 'Registered',
      company_number: '00001234',
    },
    {
      registered_charity_number: 2,
      name: 'ACME TRUST (NORTH)',
      registration_status: 'Registered',
      company_number: null,
    },
  ];
  it('matches on the company number first, then an unambiguous name', () => {
    expect(pickCharity(rows, '1234', null).facts?.registered_charity_number).toBe(1);
    expect(pickCharity(rows, null, 'Acme Trust').facts?.registered_charity_number).toBe(1);
    expect(pickCharity(rows, null, 'Acme').facts).toBeNull();
    expect(pickCharity(rows, null, 'Acme').candidates).toBe(2);
  });
});

describe('verifyOrganisation', () => {
  it('an active company with no charity or sanctions record: clean headline, no flags, three calls', async () => {
    const s = stub({ 'uk-company-profiles': [active], 'uk-charities': [], 'uk-sanctions': [] });
    const card = await verifyOrganisation(s.fetch, { company_number: '6' });
    expect(card.company.state).toBe('found');
    expect(card.flags).toEqual([]);
    expect(card.headline).toBe('Active company 00000006, no sanctions match');
    expect(s.calls.map(([src]) => src).sort()).toEqual([
      'uk-charities',
      'uk-company-profiles',
      'uk-sanctions',
    ]);
    // the searches use the register's own company name, not the typed input
    expect(s.calls.find(([src]) => src === 'uk-sanctions')?.[1].q).toBe(active.company);
  });

  it('a dissolved company with overdue accounts and a sanctions name match: sanctions headline, flags worst first', async () => {
    const s = stub({
      'uk-company-profiles': [
        {
          ...active,
          status: 'dissolved',
          dissolved_on: '2024-01-02',
          accounts_overdue: true,
          has_been_liquidated: true,
        },
      ],
      'uk-charities': [],
      'uk-sanctions': [
        {
          unique_id: 'UKS1',
          name: 'Marine and General Mutual Life Assurance Society',
          aliases: [],
          regime: 'Russia',
          date_designated: '2022-03-01',
        },
        {
          unique_id: 'UKS2',
          name: 'Someone Else',
          aliases: ['MARINE GENERAL'],
          regime: 'Libya',
          date_designated: null,
        },
      ],
    });
    const card = await verifyOrganisation(s.fetch, { name: 'Marine and General' });
    expect(card.headline).toBe('Sanctions match — do not proceed without review');
    expect(card.sanctions.hits.map((h) => h.unique_id)).toEqual(['UKS1']);
    expect(card.flags[0]).toMatch(/^On the UK sanctions list: 1 designation\(s\) \(Russia\)/);
    expect(card.flags).toContain('Companies House status: dissolved (dissolved 2024-01-02)');
    expect(card.flags).toContain('Has been in liquidation');
    expect(card.flags).toContain('Accounts overdue at Companies House');
  });

  it('a register that errors is reported as unavailable without failing the card', async () => {
    const s = stub({
      'uk-company-profiles': new Error('gankdat API 503'),
      'uk-charities': [
        {
          registered_charity_number: 7,
          name: 'ACME TRUST',
          registration_status: 'Registered',
          company_number: null,
        },
      ],
      'uk-sanctions': new Error('gankdat API 500'),
    });
    const card = await verifyOrganisation(s.fetch, { name: 'Acme Trust' });
    expect(card.company.state).toBe('unavailable');
    expect(card.charity.facts?.registered_charity_number).toBe(7);
    expect(card.sanctions.state).toBe('unavailable');
    expect(card.flags).toContain('Companies House: not checked (gankdat answered an error)');
    expect(card.flags).toContain('Sanctions list: not checked (gankdat answered an error)');
    expect(card.headline).toBe('Companies House check unavailable — try again');
  });

  it('nothing typed: no calls, a plain no-record headline', async () => {
    const s = stub({});
    const card = await verifyOrganisation(s.fetch, {});
    expect(s.calls).toEqual([]);
    expect(card.headline).toBe('No UK register record found for this name');
  });
});
