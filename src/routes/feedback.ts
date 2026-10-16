import { Hono } from 'hono';
import { z } from 'zod';
import { failure, success } from '../lib/envelope';
import { rateLimit } from '../metering/ratelimit';
import type { AppEnv } from '../types';

// Website feedback form (task 37). With the multi-niche portfolio strategy,
// this is the primary demand-signal channel: which datasets/features people
// actually want. Email is optional and used only to reply.

const feedbackBodySchema = z.object({
  message: z.string().trim().min(3).max(2000),
  email: z.email().optional(),
  /** Where the form was submitted from, e.g. '/stats/uk-tenders'. */
  page: z.string().trim().max(200).optional(),
});

const feedbackRateLimit = rateLimit({
  scope: 'feedback',
  limit: 10,
  windowSeconds: 3600,
  identify: (c) => c.req.header('CF-Connecting-IP') ?? 'unknown',
});

export const feedbackRoute = new Hono<AppEnv>().post('/', feedbackRateLimit, async (c) => {
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = feedbackBodySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    return c.json(failure('bad_request', 'Invalid request body', details), 400);
  }

  await c.env.DB.prepare('INSERT INTO feedback (message, email, page) VALUES (?1, ?2, ?3)')
    .bind(parsed.data.message, parsed.data.email ?? null, parsed.data.page ?? null)
    .run();

  return c.json(success({ received: true }));
});
