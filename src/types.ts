export interface KeyContext {
  keyId: string;
  /** Account (email identity) this key belongs to; billing + entitlement live here. */
  accountId: string;
  /** Current plan slug; the monthly quota derives from it (billing/plans.ts). Resolved from the account, not the key. */
  plan: string;
  /** Hex SHA-256 of the presented key — lets self-serve routes invalidate the KV cache. */
  keyHash: string;
  /**
   * Stable identity the monthly usage counter is keyed by (normalized email),
   * so multiple keys for one email share a free quota instead of each getting a
   * fresh 250 — you can't farm free credits by re-issuing keys.
   */
  usageSubject: string;
}

/** Set by requireSession() on browser/account routes (cookie-based auth). */
export interface AccountContext {
  accountId: string;
  email: string;
  plan: string;
}

export type AppVariables = {
  requestId: string;
  keyCtx?: KeyContext;
  accountCtx?: AccountContext;
  creditsCharged?: number;
};

export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
};
