// Cloudflare Turnstile verification for the public signup forms (key issuance,
// waitlist). Dark until TURNSTILE_SECRET_KEY is set — verification is skipped
// when it's absent, so nothing changes until the widget is configured.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(env: CloudflareBindings): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint. Returns
 * true when Turnstile is disabled (no secret). A network/parse failure is
 * treated as a failed challenge (fail-closed) when enabled.
 */
export async function verifyTurnstile(
  env: CloudflareBindings,
  token: string | undefined,
  ip: string | undefined,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
