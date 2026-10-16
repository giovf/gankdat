// Passwordless sign-in tokens. A token is a 256-bit random hex string — the
// unguessable capability, no secret/signing needed. Stored in D1 (not KV) so
// single-use is enforced ATOMICALLY: consumption is one UPDATE gated on
// used_at IS NULL, and the row-count decides the winner — two concurrent
// verifies can't both succeed (the get-then-delete KV race). Short-lived;
// expired/used rows are swept opportunistically on issue.

const MAGIC_TTL_MS = 15 * 60 * 1000;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueMagicToken(env: CloudflareBindings, email: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  // Opportunistic sweep of expired/used tokens (bounded; login is rate-limited).
  await env.DB.prepare('DELETE FROM magic_tokens WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('INSERT INTO magic_tokens (token, email, expires_at) VALUES (?1, ?2, ?3)')
    .bind(token, email, now + MAGIC_TTL_MS)
    .run();
  return token;
}

/**
 * Single-use: atomically claims the token (sets used_at only if still unused
 * and unexpired) and returns its email, or null if invalid/expired/already
 * used. The UPDATE ... RETURNING is one statement, so concurrent callers race
 * on the row and exactly one wins.
 */
export async function consumeMagicToken(
  env: CloudflareBindings,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    'UPDATE magic_tokens SET used_at = ?2 WHERE token = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING email',
  )
    .bind(token, Date.now())
    .first<{ email: string }>();
  return row?.email ?? null;
}
