import { Hono } from 'hono';
import { z } from 'zod';
import { failure, success } from '../lib/envelope';
import { queryD1Changes } from '../sources/d1store';
import { omitEmptyParams, paginationShape } from '../sources/query';
import { getSource, hasChangeFeed } from '../sources/registry';
import type { DataSource } from '../sources/types';
import type { AppEnv } from '../types';

/** Query params of /v1/changes/:source — shared with the MCP get_changes tool. */
export const changesQuerySchema = z.object({
  /** Only changes observed at or after this date/time (YYYY-MM-DD or ISO). Default: last 7 days. */
  since: z.union([z.iso.date(), z.iso.datetime()]).optional(),
  change: z.enum(['added', 'removed', 'changed']).optional(),
  ...paginationShape,
});

const FEED_KEYS = new Set(Object.keys(changesQuerySchema.shape));

/**
 * The source's own filters (+ `q`) as accepted on its change feed: the same
 * params as /v1/data/<slug>, applied to the changed record, so one call is a
 * watch — `classes=09`, `applicant=acme`, `q=<mark>`. Unknown keys are
 * rejected so a misspelt filter never silently widens a watch.
 */
export function changeFiltersSchema(source: DataSource): z.ZodObject {
  return source.queryParams.extend({ q: z.string().optional() }).strict();
}

/** Full param schema of /v1/changes/<slug>: feed params plus the source's filters. */
export function changesSchemaFor(source: DataSource): z.ZodObject {
  return changeFiltersSchema(source).extend(changesQuerySchema.shape);
}

/** Splits a parsed /v1/changes query into feed params and the source filters. */
export function splitChangesQuery(parsed: Record<string, unknown>): {
  feed: z.infer<typeof changesQuerySchema>;
  filters: Record<string, unknown>;
} {
  const feed: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (FEED_KEYS.has(key)) feed[key] = value;
    else filters[key] = value;
  }
  return { feed: feed as z.infer<typeof changesQuerySchema>, filters };
}

/**
 * "What changed since <date>" for register-style datasets (those with a stable
 * record id): rows added, removed or changed between daily refreshes, newest
 * first, filterable with the source's own params. Metered like a data query.
 * Task 51.
 */
export const changesRoutes = new Hono<AppEnv>().get('/:source', async (c) => {
  const slug = c.req.param('source');
  const source = getSource(slug);
  if (!source) return c.json(failure('not_found', `Unknown source '${slug}'`), 404);
  if (!hasChangeFeed(source)) {
    return c.json(
      failure('not_found', `Source '${slug}' has no change feed (no stable record id)`),
      404,
    );
  }
  const parsed = changesSchemaFor(source).safeParse(omitEmptyParams(c.req.query()));
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      param: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    return c.json(failure('bad_request', 'Invalid query parameters', details), 400);
  }
  if (c.req.method === 'HEAD') return c.body(null, 200);
  const { feed, filters } = splitChangesQuery(parsed.data as Record<string, unknown>);
  const since = feed.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const result = await queryD1Changes(c.env, source, { ...feed, since, filters });
  return c.json(
    success(result.rows, {
      source: source.slug,
      since,
      page: feed.page,
      per_page: feed.per_page,
      total: result.total,
      last_refreshed_at: result.last_refreshed_at,
    }),
  );
});
