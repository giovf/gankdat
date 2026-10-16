import { Hono } from 'hono';
import { getOpenApiDocument } from '../lib/openapi';
import { publicBaseUrl } from '../lib/constants';
import type { AppEnv } from '../types';

export const openapiRoute = new Hono<AppEnv>().get('/', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(getOpenApiDocument(publicBaseUrl(c.env)));
});
