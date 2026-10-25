import { describe, expect, it } from 'vitest';

import { changesByUaNote } from '../src/lib/change-feed-callers';

describe('changesByUaNote', () => {
  it('names the UA families behind the change-feed calls with their surface and probe tag', () => {
    expect(
      changesByUaNote([
        { kind: 'rest_changes', ua: 'python-requests/2.34.2', n: 3 },
        { kind: 'mcp_authed', ua: 'python-requests/2.31.0', n: '1' },
        { kind: 'rest_changes', ua: 'SettledScout/0.1', n: 1 },
        { kind: 'rest_changes', ua: 'curl/8', n: 0 },
      ]),
    ).toBe('changes 7d by UA: python-requests 4 (mcp, rest), SettledScout 1 (rest, prober)');
  });

  it('reads none for an empty window and n/a for a failed read', () => {
    expect(changesByUaNote([])).toBe('changes 7d by UA: none');
    expect(changesByUaNote([{ kind: 'rest_changes', ua: 'curl/8', n: 0 }])).toBe(
      'changes 7d by UA: none',
    );
    expect(changesByUaNote(null)).toBe('changes 7d by UA: n/a');
  });

  it('keeps a missing UA readable', () => {
    expect(changesByUaNote([{ kind: 'rest_changes', ua: '', n: 2 }])).toBe(
      'changes 7d by UA: (no UA) 2 (rest)',
    );
  });
});
