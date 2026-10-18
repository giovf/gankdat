import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from '../src/lib/deadline';
import { buildMcpServer, slowMessage, TOOL_CALL_BUDGET_MS } from '../src/mcp/server';
import { getSource } from '../src/sources/registry';
import { bearer, issueKey } from './helpers/auth';

// gankdat `refresh-mcp-probe` (2026-10-18): the keyless probe's tools/call hung for 20 s once
// while the keyed call answered at once. Two guards: a data tool answers a tool error naming
// the phase once the call budget passes (never a hang), and a stateless POST answers one
// JSON body inside the fetch handler (no SSE stream whose work runs after the handler
// returned). These tests are the probe's three calls, keyless then keyed.

const MCP_URL = 'https://example.com/mcp';
const PROBE_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'user-agent': 'gankdat-mcp-probe/1 (metrics job)',
  'CF-Connecting-IP': '203.0.113.77',
};

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
}

async function callTool(
  budgetMs: number,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = buildMcpServer(
    env,
    null,
    { clientId: 'deadline-test', userAgent: 'test' },
    budgetMs,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'deadline-test', version: '1' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withDeadline', () => {
  it('returns the value when the work settles in time', async () => {
    expect(await withDeadline(Promise.resolve(7), 1_000)).toEqual({ ok: true, value: 7 });
  });

  it('expires when the work is still pending', async () => {
    const never = new Promise<number>(() => undefined);
    expect(await withDeadline(never, 5)).toEqual({ ok: false });
  });

  it('propagates a rejection', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });
});

describe('data tools under the call budget', () => {
  it('answers a tool error naming the phase when the snapshot read hangs', async () => {
    // Every CACHE read hangs: the preview gate (RATE) passes, the snapshot read never returns.
    vi.spyOn(env.CACHE, 'get').mockImplementation(() => new Promise(() => undefined));
    const result = await callTool(50, 'query_uk_tenders', { per_page: 1 });
    expect(result.isError).toBe(true);
    const source = getSource('uk-tenders');
    expect(source).toBeDefined();
    expect(result.content?.[0]?.text).toBe(slowMessage(source!, 'query', 50));
    expect(result.content?.[0]?.text).toContain('stuck at query');
  });

  it('answers rows when the call is fast', async () => {
    const result = await callTool(TOOL_CALL_BUDGET_MS, 'query_uk_tenders', { per_page: 1 });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as { ok?: boolean };
    expect(payload.ok).toBe(true);
  });
});

describe('/mcp answers a POST with one JSON body (the probe path)', () => {
  async function post(
    body: Record<string, unknown>,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; type: string; body: Record<string, unknown> }> {
    const res = await SELF.fetch(MCP_URL, {
      method: 'POST',
      headers: { ...PROBE_HEADERS, ...extra },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  const probe = async (extra: Record<string, string> = {}): Promise<void> => {
    const init = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'gankdat-mcp-probe', version: '1' },
        },
      },
      extra,
    );
    expect(init.status).toBe(200);
    expect(init.type).toContain('application/json');
    expect(init.body.result).toBeDefined();

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, extra);
    expect(list.type).toContain('application/json');
    const tools = (list.body.result as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === 'query_uk_tenders')).toBe(true);

    const call = await post(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_uk_tenders', arguments: { per_page: 1 } },
      },
      extra,
    );
    expect(call.status).toBe(200);
    expect(call.type).toContain('application/json');
    const result = call.body.result as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toMatchObject({ ok: true });
  };

  it('keyless: initialize, tools/list, one preview tools/call', async () => {
    await probe();
  });

  it('keyed: the same three calls with a bearer key', async () => {
    const { key } = await issueKey();
    await probe(bearer(key) as Record<string, string>);
  });
});
