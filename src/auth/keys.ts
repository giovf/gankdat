const KEY_PREFIX = 'fapi_';
const KEY_LENGTH = 32;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `fapi_` + 32 base62 chars (~190 bits). Rejection sampling keeps the
 * distribution uniform (256 % 62 !== 0).
 */
export function generateKey(): string {
  const chars: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (chars.length < KEY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH * 2));
    for (const byte of bytes) {
      if (byte < limit && chars.length < KEY_LENGTH) {
        chars.push(ALPHABET[byte % ALPHABET.length]!);
      }
    }
  }
  return `${KEY_PREFIX}${chars.join('')}`;
}

/** Hex SHA-256 — the only form of a key ever persisted. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time comparison for secrets (e.g. the admin token) so a `!==` check
 * can't be timing-probed byte by byte. Length is allowed to leak; content
 * comparison is timing-independent.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
