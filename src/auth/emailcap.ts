// Per-EMAIL send cap shared by every path that emails a sign-in/approval link
// (browser login and the agent sign-up): stops an attacker rotating IPs from
// bombing one victim's inbox. Enforced silently by callers — a capped request
// returns the same generic response and just doesn't send, so it neither
// enumerates accounts nor tells the attacker they were throttled.

const EMAIL_CAP = 4;
const EMAIL_CAP_WINDOW_SECONDS = 3600;
const capKey = (email: string): string => `loginsent:${email}`;

/** True when another link may be sent to this (normalized) email this hour. */
export async function emailSendAllowed(env: CloudflareBindings, email: string): Promise<boolean> {
  return Number((await env.CACHE.get(capKey(email))) ?? '0') < EMAIL_CAP;
}

/** Count one sent link against the email's hourly cap. */
export async function recordEmailSend(env: CloudflareBindings, email: string): Promise<void> {
  const already = Number((await env.CACHE.get(capKey(email))) ?? '0');
  await env.CACHE.put(capKey(email), String(already + 1), {
    expirationTtl: EMAIL_CAP_WINDOW_SECONDS,
  });
}
