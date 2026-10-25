import { describe, expect, it } from 'vitest';

import { REST_UA_TOP, restByUaNote } from '../src/lib/rest-callers';

describe('restByUaNote', () => {
  it('names the UA families behind the REST data calls with their dataset count and probe tag', () => {
    expect(
      restByUaNote([
        { ua: 'python-requests/2.34.2', slug: 'uk-tenders', n: 3 },
        { ua: 'python-requests/2.31.0', slug: 'uk-sanctions', n: '9' },
        { ua: 'azure-logic-apps/1.0 (workflow abc)', slug: 'uk-charities', n: 2 },
        { ua: 'SettledScout/0.1', slug: 'eu-ted', n: 1 },
        { ua: 'curl/8', slug: 'nhs-ods', n: 0 },
      ]),
    ).toBe(
      'rest 7d by UA: python-requests 12 (2 datasets), azure-logic-apps 2 (1 dataset), SettledScout 1 (1 dataset, prober)',
    );
  });

  it('names the top families and counts the rest', () => {
    const rows = Array.from({ length: REST_UA_TOP + 2 }, (_, i) => ({
      ua: `agent-${String(i).padStart(2, '0')}/1.0`,
      slug: 'uk-tenders',
      n: 20 - i,
    }));
    const note = restByUaNote(rows);
    expect(note).toContain('agent-00 20 (1 dataset)');
    expect(note).not.toContain('agent-09');
    expect(note.endsWith(' +2 more')).toBe(true);
  });

  it('reads none for an empty window and n/a for a failed read', () => {
    expect(restByUaNote([])).toBe('rest 7d by UA: none');
    expect(restByUaNote([{ ua: 'curl/8', slug: 'x', n: 0 }])).toBe('rest 7d by UA: none');
    expect(restByUaNote(null)).toBe('rest 7d by UA: n/a');
  });

  it('keeps a missing UA and a missing slug readable', () => {
    expect(restByUaNote([{ ua: '', slug: null, n: 2 }])).toBe(
      'rest 7d by UA: (no UA) 2 (0 datasets)',
    );
  });
});
