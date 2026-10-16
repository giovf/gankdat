import { Hono } from 'hono';
import { timingSafeEqual } from '../auth/keys';
import { invalidateKeyCache, requireApiKey } from '../auth/middleware';
import { failure, success } from '../lib/envelope';
import type { AppEnv } from '../types';

async function revokeKey(env: CloudflareBindings, keyId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT key_hash FROM api_keys WHERE id = ?1 AND revoked_at IS NULL',
  )
    .bind(keyId)
    .first<{ key_hash: string }>();
  if (!row) return false;

  await env.DB.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?1")
    .bind(keyId)
    .run();
  // Drop the hot-path cache and write a revocation tombstone so the revocation
  // holds even through the D1-outage isolate-cache fallback.
  await invalidateKeyCache(env, row.key_hash);
  return true;
}

export const keysRoutes = new Hono<AppEnv>()
  // Issuance is retired here and lives behind verified sign-in (POST
  // /v1/account/keys). The old public form accepted any UNVERIFIED email —
  // harmless when keys were standalone free-tier objects, a privilege leak once
  // keys inherit the account's plan (type a stranger's email, get a key on
  // their paid account, burn their quota). Magic-link sign-in proves ownership.
  .post('/', (c) =>
    c.json(
      failure(
        'gone',
        'Key issuance has moved: sign in at /account (email magic link) and create keys from your dashboard',
      ),
      410,
    ),
  )
  // Self-serve revocation of the presented key.
  .delete('/', requireApiKey(), async (c) => {
    const keyCtx = c.get('keyCtx')!;
    await revokeKey(c.env, keyCtx.keyId);
    return c.json(success({ revoked: true }));
  })
  // Operator revocation by key id, guarded by the ADMIN_TOKEN secret.
  .delete('/:id', async (c) => {
    const token = c.req.header('X-Admin-Token');
    if (!c.env.ADMIN_TOKEN || !token || !timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
      return c.json(failure('unauthorized', 'Admin token required'), 401);
    }
    const revoked = await revokeKey(c.env, c.req.param('id'));
    if (!revoked) {
      return c.json(failure('not_found', 'No active key with that id'), 404);
    }
    return c.json(success({ revoked: true }));
  });
