import 'server-only';
import { rateLimitHit } from '../db';

// Rate limits for our own entry points (ADR 011): sign-in starts and callbacks on both
// pools, and password resets. Counters live in Postgres (core.rate_limit_hit), so they
// survive restarts and are shared by every process. Wrong passwords typed on the Cognito
// page never reach us; Cognito's own lockout covers those.

export const LIMITS = {
  signIn: { limit: 30, windowS: 300 }, // per client address
  passwordReset: { limit: 10, windowS: 3600 }, // per admin
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
