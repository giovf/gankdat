// Transactional email via the Resend REST API (plain fetch — no SDK, so it stays
// Workers-clean with zero npm dependency). Dark/no-op when RESEND_API_KEY is
// unset, mirroring the Turnstile/x402 "ships dark until configured" pattern:
// callers get `false` and a warning log rather than a thrown error.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
// Resend's shared onboarding sender needs no DNS — fine for testing. Swap to a
// verified domain (e.g. no-reply@gankdat.com) via EMAIL_FROM once it exists.
const DEFAULT_FROM = 'gankdat <onboarding@resend.dev>';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function emailEnabled(env: CloudflareBindings): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/** Returns true only if the provider accepted the message. */
export async function sendEmail(env: CloudflareBindings, msg: EmailMessage): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'email_disabled', to: msg.to, subject: msg.subject }),
    );
    return false;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || DEFAULT_FROM,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'email_send_failed',
        status: res.status,
        detail: detail.slice(0, 200),
      }),
    );
    return false;
  }
  console.log(
    JSON.stringify({ level: 'info', event: 'email_sent', to: msg.to, subject: msg.subject }),
  );
  return true;
}
