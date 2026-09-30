import { nowSeconds, signToken, verifyToken } from '../auth/session';
import type { CognitoConfig, IdTokenClaims } from '../auth/cognito';

// Platform admin sessions (ADR 012), kept apart from customer sessions:
//  * their own cookie, limited to /platform, SameSite=Strict
//  * signed with a key derived for the platform only, so a customer token never verifies
//    as a platform one (and the other way round)
//  * 30 minutes idle, 8 hours absolute

export const PLATFORM_COOKIE = 'oo_platform';
export const PLATFORM_PKCE_COOKIE = 'oo_platform_pkce';
export const PLATFORM_IDLE_S = 30 * 60;
export const PLATFORM_ABSOLUTE_S = 8 * 60 * 60;
export const PLATFORM_TOUCH_AFTER_S = 60;
export const PLATFORM_ADMINS_GROUP = 'platform-admins';

export interface PlatformSession {
  v: 1;
  kind: 'platform';
  /** platform.admin id */
  aid: string;
  iat: number;
  seen: number;
}

export type PlatformVerify =
  { ok: true; payload: PlatformSession } | { ok: false; reason: 'invalid' | 'idle' | 'absolute' };

const platformKey = (secret: string) => `${secret}|platform-admin`;

export function newPlatformSession(aid: string, now = nowSeconds()): PlatformSession {
  return { v: 1, kind: 'platform', aid, iat: now, seen: now };
}

export function signPlatformSession(p: PlatformSession, secret: string): Promise<string> {
  return signToken(p, platformKey(secret));
}

export async function verifyPlatformSession(
  token: string | undefined,
  secret: string,
  now = nowSeconds(),
): Promise<PlatformVerify> {
  const p = (await verifyToken(token, platformKey(secret))) as PlatformSession | null;
  if (!p || p.v !== 1 || p.kind !== 'platform' || typeof p.aid !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  if (now - p.iat > PLATFORM_ABSOLUTE_S) return { ok: false, reason: 'absolute' };
  if (now - p.seen > PLATFORM_IDLE_S) return { ok: false, reason: 'idle' };
  return { ok: true, payload: p };
}

export function platformMaxAge(p: PlatformSession, now = nowSeconds()): number {
  return Math.max(0, Math.min(p.iat + PLATFORM_ABSOLUTE_S, p.seen + PLATFORM_IDLE_S) - now);
}

export const platformCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/platform',
};

/**
 * Only members of the platform-admins group on the platform pool become platform admins
 * (ADR 012). Anyone else who somehow signs in to that pool gets nothing.
 */
export function isPlatformAdmin(
  claims: IdTokenClaims,
): claims is IdTokenClaims & { email: string } {
  return claims.groups.includes(PLATFORM_ADMINS_GROUP) && !!claims.email;
}

/** The platform pool (its own users, client and domain), or null when not configured. */
export function platformCognitoConfig(
  env: Record<string, string | undefined> = process.env,
): CognitoConfig | null {
  const {
    PLATFORM_COGNITO_USER_POOL_ID,
    PLATFORM_COGNITO_CLIENT_ID,
    PLATFORM_COGNITO_DOMAIN,
    APP_URL,
  } = env;
  if (
    !PLATFORM_COGNITO_USER_POOL_ID ||
    !PLATFORM_COGNITO_CLIENT_ID ||
    !PLATFORM_COGNITO_DOMAIN ||
    !APP_URL
  ) {
    return null;
  }
  return {
    userPoolId: PLATFORM_COGNITO_USER_POOL_ID,
    clientId: PLATFORM_COGNITO_CLIENT_ID,
    domain: PLATFORM_COGNITO_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appUrl: APP_URL.replace(/\/$/, ''),
    callbackPath: '/platform/auth/callback',
    logoutPath: '/platform/signed-out',
    scope: 'openid email',
  };
}
