import type { EmailMessage } from './send';

// Plain, dependency-free HTML — inline styles only (email clients strip <style>).
export function magicLinkEmail(to: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Your gankdat sign-in link',
    text:
      `Sign in to gankdat:\n${link}\n\n` +
      'This link expires in 15 minutes and can be used once. ' +
      "If you didn't request it, you can ignore this email.",
    html: `<!doctype html><html><body style="margin:0;background:#f6f7f9;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16181d">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px">
    <h1 style="font-size:1.3rem;margin:0 0 8px">Sign in to gankdat</h1>
    <p style="color:#5b6472;margin:0 0 20px">Click the button below to sign in. This link expires in 15 minutes and can be used once.</p>
    <a href="${link}" style="display:inline-block;background:#0b5fff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Sign in</a>
    <p style="color:#5b6472;font-size:.85rem;margin:24px 0 0;word-break:break-all">Or paste this URL into your browser:<br>${link}</p>
    <p style="color:#9aa3b2;font-size:.8rem;margin:20px 0 0">If you didn't request this, you can safely ignore it.</p>
  </div>
</body></html>`,
  };
}

/**
 * Sent when an AI agent asks for a key on the user's behalf. The code is the
 * user's cross-check against what the agent showed them; the link approves.
 */
export function agentKeyRequestEmail(
  to: string,
  link: string,
  code: string,
  clientName: string | null,
): EmailMessage {
  const who = clientName ? `"${clientName}"` : 'an AI agent or app';
  return {
    to,
    subject: `Approve an API key request (${code}) — gankdat`,
    text:
      `${who} asked gankdat for an API key for this email address.\n\n` +
      `Approval code: ${code}\n` +
      `If this matches the code your agent showed you, approve here:\n${link}\n\n` +
      'The link expires in 30 minutes and works once. The key will belong to your gankdat ' +
      'account (created if new) and inherit its plan; you can revoke it any time at ' +
      "https://gankdat.com/account. If you didn't ask for this, ignore this email — nothing happens.",
    html: `<!doctype html><html><body style="margin:0;background:#f6f7f9;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16181d">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px">
    <h1 style="font-size:1.3rem;margin:0 0 8px">Approve an API key request</h1>
    <p style="color:#5b6472;margin:0 0 16px">${who} asked gankdat for an API key for this email address. Approve only if the code below matches the one your agent showed you.</p>
    <p style="font:700 1.6rem ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;margin:0 0 20px">${code}</p>
    <a href="${link}" style="display:inline-block;background:#0b5fff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Approve and issue the key</a>
    <p style="color:#5b6472;font-size:.85rem;margin:24px 0 0">The link expires in 30 minutes and works once. The key will belong to your gankdat account (created if new) and inherit its plan; revoke it any time at <a href="https://gankdat.com/account">gankdat.com/account</a>.</p>
    <p style="color:#5b6472;font-size:.85rem;margin:12px 0 0;word-break:break-all">Or paste this URL into your browser:<br>${link}</p>
    <p style="color:#9aa3b2;font-size:.8rem;margin:20px 0 0">If you didn't ask for this, ignore this email — nothing happens.</p>
  </div>
</body></html>`,
  };
}
