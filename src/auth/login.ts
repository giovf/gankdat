// Magic-link sign-in, shared by POST /v1/auth/login (the /account page) and
// the OAuth consent flow (/authorize/login), which needs the emailed link to
// bring the user back to the pending authorization instead of the dashboard.

import { normalizeEmail } from './accounts';
import { emailSendAllowed, recordEmailSend } from './emailcap';
import { issueMagicToken } from './magiclink';
import { REQUEST_ID_RE } from './oauth';
import { emailEnabled, sendEmail } from '../email/send';
import { magicLinkEmail } from '../email/templates';
import { publicBaseUrl } from '../lib/constants';

/**
 * Where a verified sign-in may land besides /account: only the OAuth consent
 * page for a request id, so the emailed link can never be pointed elsewhere.
 */
export function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  const match = /^\/authorize\?request=([a-f0-9]{32})$/.exec(next);
  return match && REQUEST_ID_RE.test(match[1]!) ? next : null;
}

export type MagicLinkOutcome = 'sent' | 'capped' | 'send_failed' | 'disabled';

/** Issue a token and email the link; `next` (already validated) rides along to /verify. */
export async function startMagicLinkSignIn(
  env: CloudflareBindings,
  emailRaw: string,
  next: string | null,
): Promise<MagicLinkOutcome> {
  if (!emailEnabled(env)) return 'disabled';
  const email = normalizeEmail(emailRaw);
  if (!(await emailSendAllowed(env, email))) return 'capped';
  const token = await issueMagicToken(env, email);
  const base = publicBaseUrl(env);
  const link = `${base}/v1/auth/verify?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const sent = await sendEmail(env, magicLinkEmail(email, link));
  if (!sent) return 'send_failed';
  await recordEmailSend(env, email);
  return 'sent';
}
