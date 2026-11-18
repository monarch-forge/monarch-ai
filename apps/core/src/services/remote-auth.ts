/** Phone-access token hashing + one-time pairing codes (pure; no kernel imports so it unit-tests in isolation). */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PAIR_TTL_MS = 5 * 60_000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function tokenMatches(token: string, hashHex: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TooManyAttempts extends Error {
  status = 429;
}

/** one pending pairing code at a time; failed redeems are rate-limited (5/min) */
export class Pairing {
  private pending: { hash: string; expiresAt: number } | null = null;
  private failures: number[] = [];
  create(now = Date.now()): { code: string; expiresAt: number } {
    const code = randomBytes(12).toString('base64url');
    this.pending = { hash: hashToken(code), expiresAt: now + PAIR_TTL_MS };
    return { code, expiresAt: this.pending.expiresAt };
  }
  /** true = code valid (and now consumed). Throws TooManyAttempts (429) after 5 failures in a minute. */
  redeem(code: string, now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= 5) throw new TooManyAttempts('Too many pairing attempts — wait a minute');
    const p = this.pending;
    if (p && now < p.expiresAt && typeof code === 'string' && code && tokenMatches(code, p.hash)) {
      this.pending = null;
      return true;
    }
    this.failures.push(now);
    return false;
  }
  cancel(): void {
    this.pending = null;
  }
}
