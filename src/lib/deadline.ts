// A bound on how long one piece of request-path work may take before the caller answers
// something else (gankdat `refresh-mcp-probe`, 2026-10-18): the keyless MCP probe of
// 2026-10-18 07:10 timed out at 20 s on one tools/call whose snapshot was fresh and small,
// while the keyed call a moment later answered at once. The Worker cannot read what hung
// (the request path logs nothing on a slow KV op), so every data-tool call now runs under
// a deadline and a call that misses it answers a tool error naming the phase — a reading a
// directory's health check and the Daily numbers row can both carry — instead of a hang.

export type Settled<T> = { ok: true; value: T } | { ok: false };

/**
 * Resolve with the work's value, or `{ ok: false }` once `ms` have passed without it. The
 * work itself keeps running (nothing in a Worker can cancel a KV read); the caller decides
 * what a late result is worth — see `expired` on the MCP tool handlers.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
