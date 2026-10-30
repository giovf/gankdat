import { describe, expect, it } from 'vitest';
import {
  claudeClientsNote,
  claudeClientsOf,
  claudeClientsSql,
  crawlerFamily,
  crawlerNote,
  foldFamilies,
  foldStatsLogEvents,
  mcpCrawlerSql,
  statsLineOf,
  statsPageLogQuery,
  zoneStatsQuery,
  zoneStatsRows,
} from '../src/lib/crawler-hits.js';

describe('crawlerFamily', () => {
  it('names the AI crawler families and nothing else', () => {
    expect(
      crawlerFamily(
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      ),
    ).toBe('GPTBot');
    expect(crawlerFamily('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe(
      'ClaudeBot',
    );
    expect(
      crawlerFamily('Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)'),
    ).toBe('Bytespider');
    expect(crawlerFamily('CCBot/2.0 (https://commoncrawl.org/faq/)')).toBe('CCBot');
    expect(
      crawlerFamily(
        'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      ),
    ).toBe('PerplexityBot');
    expect(
      crawlerFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'),
    ).toBeNull();
    expect(crawlerFamily('')).toBeNull();
  });
});

describe('foldFamilies', () => {
  it('sums hits by family, descending, and keeps the non-AI total', () => {
    const hits = foldFamilies([
      { userAgent: 'GPTBot/1.2', hits: 3 },
      { userAgent: 'Chrome/130', hits: 10 },
      { userAgent: 'ClaudeBot/1.0', hits: 5 },
      { userAgent: 'GPTBot/1.1', hits: 4 },
      { userAgent: 'CCBot/2.0', hits: 0 },
    ]);
    expect(hits).toEqual({ total: 22, ai: 12, byFamily: { GPTBot: 7, ClaudeBot: 5 } });
  });
});

describe('stats-page log reading', () => {
  const line = (path: string, userAgent: string) => ({
    timestamp: 1_760_000_000_000,
    $metadata: {
      message: JSON.stringify({ level: 'info', method: 'GET', path, status: 200, userAgent }),
    },
  });

  it('builds the documented Query Builder body with the request-line needle', () => {
    const q = statsPageLogQuery(1_000_000_000_000, 24, 50);
    expect(q).toMatchObject({
      view: 'events',
      limit: 50,
      timeframe: { from: 1_000_000_000_000 - 86_400_000, to: 1_000_000_000_000 },
      parameters: {
        datasets: ['cloudflare-workers'],
        needle: { value: '/stats', isRegex: false, matchCase: true },
      },
    });
  });

  it('reads path and user agent from the Worker line and ignores other lines', () => {
    expect(statsLineOf(line('/stats/uk-planning', 'GPTBot/1.2'))).toEqual({
      path: '/stats/uk-planning',
      userAgent: 'GPTBot/1.2',
    });
    expect(statsLineOf(line('/mcp', 'GPTBot/1.2'))).toBeNull();
    expect(statsLineOf({ $metadata: { message: 'GET https://gankdat.com/stats/x' } })).toBeNull();
    expect(statsLineOf('nope')).toBeNull();
  });

  it('folds a response into family counts and reports the raw line count', () => {
    const body = {
      result: {
        events: {
          events: [
            line('/stats/uk-planning', 'GPTBot/1.2'),
            line('/stats/uk-planning', 'Mozilla/5.0 Chrome/130'),
            line('/stats', 'ClaudeBot/1.0'),
            { $metadata: { message: 'x402: Route "/v1/x" has an invalid bazaar extension' } },
          ],
        },
      },
    };
    expect(foldStatsLogEvents(body)).toEqual({
      total: 3,
      ai: 2,
      byFamily: { GPTBot: 1, ClaudeBot: 1 },
      lines: 4,
    });
    expect(foldStatsLogEvents({ result: { events: { events: [] } } })).toEqual({
      total: 0,
      ai: 0,
      byFamily: {},
      lines: 0,
    });
  });
});

describe('zone and /mcp readings', () => {
  it('asks the zone for /stats requests by user agent in the window', () => {
    const q = zoneStatsQuery('abc', '2026-09-17T00:00:00Z', '2026-10-17T00:00:00Z');
    expect(q).toContain('zoneTag: "abc"');
    expect(q).toContain('clientRequestPath_like: "/stats%"');
    expect(q).toContain('dimensions { userAgent }');
  });

  it('reads the groups out of the GraphQL body', () => {
    const body = {
      data: {
        viewer: {
          zones: [
            {
              httpRequestsAdaptiveGroups: [
                { count: 12, dimensions: { userAgent: 'GPTBot/1.2' } },
                { count: 3, dimensions: { userAgent: 'curl/8' } },
              ],
            },
          ],
        },
      },
    };
    expect(zoneStatsRows(body)).toEqual([
      { userAgent: 'GPTBot/1.2', hits: 12 },
      { userAgent: 'curl/8', hits: 3 },
    ]);
    expect(zoneStatsRows({ errors: [{ message: 'x' }] })).toEqual([]);
  });

  it('corrects the Analytics Engine count for sampling', () => {
    expect(mcpCrawlerSql(30)).toContain("INTERVAL '30' DAY");
    expect(mcpCrawlerSql(30)).toContain('SUM(_sample_interval * double1)');
  });
});

describe('crawlerNote', () => {
  it('writes one clause per surface and n/a with the reason', () => {
    const note = crawlerNote({
      statsLogs: {
        total: 5000,
        ai: 40,
        byFamily: { GPTBot: 40 },
        lines: 5000,
        hours: 168,
        limit: 5000,
      },
      zone: { error: 'HTTP 403' },
      mcp: { total: 900, ai: 120, byFamily: { ClaudeBot: 100, GPTBot: 20 }, days: 30 },
    });
    expect(note).toBe(
      'stats crawlers: logs 5000+ fetches/7d, AI 40 (GPTBot 40); zone n/a (HTTP 403); /mcp 900 req/30d, AI 120 (ClaudeBot 100, GPTBot 20)',
    );
  });

  it('says when the needle matched lines that were not request lines (the 2026-10-17 17:28 reading)', () => {
    const note = crawlerNote({
      statsLogs: { total: 0, ai: 0, byFamily: {}, lines: 18, hours: 168, limit: 1000 },
      zone: { error: 'zone: no permission' },
      mcp: { error: 'mcp: down' },
    });
    expect(note).toBe(
      'stats crawlers: logs 0 fetches/7d, AI 0 (none) — 18 lines matched, none a request line; zone n/a (zone: no permission); /mcp n/a (mcp: down)',
    );
  });
});

describe('claude tool callers (claude-directory-day-30)', () => {
  it('counts distinct clients of MCP tools/call requests from the Claude surfaces only', () => {
    const sql = claudeClientsSql(30);
    expect(sql).toContain('COUNT(DISTINCT blob6)');
    expect(sql).toContain("INTERVAL '30' DAY");
    expect(sql).toContain("blob1 IN ('mcp_authed', 'mcp_anon', 'mcp_preview')");
    expect(sql).toContain("blob2 LIKE '%Claude-User%'");
    expect(sql).toContain("blob3 LIKE '%tools/call%'");
    expect(sql).not.toContain('rest_');
  });

  it('reads one row and treats an empty result as zero', () => {
    expect(claudeClientsOf([{ clients: '7', calls: 123.4 }])).toEqual({ clients: 7, calls: 123 });
    expect(claudeClientsOf([])).toEqual({ clients: 0, calls: 0 });
  });

  it('writes the clause with n/a per window', () => {
    expect(
      claudeClientsNote({ d30: { clients: 7, calls: 123 }, d7: { clients: 2, calls: 9 } }),
    ).toBe('claude tool callers: 30d 7 clients, 123 calls; 7d 2 clients, 9 calls');
    expect(claudeClientsNote({ d30: { error: 'ae: down' }, d7: { clients: 0, calls: 0 } })).toBe(
      'claude tool callers: 30d n/a (ae: down); 7d 0 clients, 0 calls',
    );
  });
});
