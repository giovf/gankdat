// The account (email identity) is the single subject for plan, quota, usage, and
// billing. Keys are issued under it and inherit its plan. This helper upserts by
// normalized email so both key issuance and magic-link sign-in resolve the same
// account.

export interface Account {
  id: string;
  plan: string;
}

// Canonicalize to one identity per real inbox so sub-address / dot variants
// can't mint multiple free-tier accounts (task 25 item 1). Beyond trim +
// lowercase: strip `+tag` sub-addressing (all domains — it delivers to the
// base inbox where supported) and collapse dots in the local part for Gmail
// (which ignores them; dots are significant elsewhere, so only Gmail). The
// canonical address is still deliverable, so magic links reach the user.
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed; // malformed — zod validates the real shape upstream
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus); // keep non-empty base only

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const dotless = local.replaceAll('.', '');
    if (dotless) local = dotless;
  }
  return `${local}@${domain}`;
}

export async function getOrCreateAccount(
  env: CloudflareBindings,
  emailRaw: string,
): Promise<Account> {
  const email = normalizeEmail(emailRaw);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO accounts (id, email) VALUES (?1, ?2) ON CONFLICT (email) DO NOTHING',
  )
    .bind(id, email)
    .run();
  // Re-select rather than trust the insert: on conflict we want the existing row
  // (and its current, possibly-paid plan).
  return (await env.DB.prepare('SELECT id, plan FROM accounts WHERE email = ?1')
    .bind(email)
    .first<Account>())!;
}
