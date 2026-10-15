import 'server-only';
import { rateLimitHit } from '../db';

// Rate limits for our own entry points (ADR 011): sign-in starts and callbacks on both
// pools, password resets, and people changing their own password (ADR 018). Counters live
// in Postgres (core.rate_limit_hit), so they survive restarts and are shared by every
// process. Our own sign-in screen (ADR 161) also limits each login; Cognito's own lockout
// still applies behind it.

export const LIMITS = {
  signIn: { limit: 30, windowS: 300 }, // per client address
  signInLogin: { limit: 10, windowS: 900 }, // passwords and codes tried for one login (ADR 161)
  signInEmail: { limit: 5, windowS: 3600 }, // emails sent for one login: codes and resets
  passwordReset: { limit: 10, windowS: 3600 }, // per admin
  passwordChange: { limit: 5, windowS: 3600 }, // per person, their own (ADR 018)
} as const;

/** The client address as Caddy forwards it (first X-Forwarded-For entry). */
export function clientAddress(headers: { get(name: string): string | null }): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** True while `key` is within its limit; counts this hit. */
export function withinLimit(
  key: string,
  { limit, windowS }: { limit: number; windowS: number },
): Promise<boolean> {
  return rateLimitHit(key, limit, windowS);
}
