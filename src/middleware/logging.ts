import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/**
 * Structured JSON request logging + X-Request-Id response header.
 * Fields for key id / credits charged are appended once auth (task 6) and
 * metering (task 7) put them on the context.
 */
export function structuredLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    c.res.headers.set('X-Request-Id', c.get('requestId'));
    console.log(
      JSON.stringify({
        level: 'info',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        latencyMs: Date.now() - start,
        keyId: c.get('keyCtx')?.keyId,
        creditsCharged: c.get('creditsCharged'),
        // Identifies crawlers/agents (anonymous MCP introspection has no
        // keyId; the UA says who's indexing us). UA only — no IPs logged.
        userAgent: c.req.header('User-Agent'),
      }),
    );
  };
}
