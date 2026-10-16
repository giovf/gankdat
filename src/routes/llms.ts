import { Hono } from 'hono';
import { getLlmsTxt } from '../lib/llms';
import { publicBaseUrl } from '../lib/constants';
import type { AppEnv } from '../types';

// Served by the Worker (public/llms.txt was deleted — static assets match
// before Worker routes, so a stale file there would shadow this).
export const llmsRoute = new Hono<AppEnv>().get('/', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.text(getLlmsTxt(publicBaseUrl(c.env)));
});
