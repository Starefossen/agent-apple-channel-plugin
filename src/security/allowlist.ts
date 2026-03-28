/**
 * Checks whether a sender is permitted to communicate with the agent.
 *
 * Implementations may use a static list, a database, or an external
 * service. The interface is intentionally minimal to support all of these.
 */
export interface AllowlistChecker {
  /** Returns `true` if the sender address is in the allowlist. */
  isAllowed(sender: string): boolean;
}

/**
 * Email-address-based allowlist with case-insensitive comparison.
 *
 * Addresses are normalized (trimmed, lowercased) at construction time
 * and stored in a Set for O(1) lookups.
 */
export class Allowlist implements AllowlistChecker {
  private readonly normalized: ReadonlySet<string>;

  constructor(addresses: readonly string[]) {
    this.normalized = new Set(addresses.map(normalizeEmail));
  }

  isAllowed(sender: string): boolean {
    return this.normalized.has(normalizeEmail(sender));
  }

  /** Number of entries in the allowlist. */
  get size(): number {
    return this.normalized.size;
  }

  /** The set of normalized allowed addresses (for diagnostics). */
  get entries(): ReadonlySet<string> {
    return this.normalized;
  }
}

/** Normalize an email address for comparison: trim and lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
