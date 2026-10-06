import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COGNITO_GRACE_S,
  SESSION_COOKIE,
  newSession,
  nowSeconds,
  signSession,
} from '@/lib/auth/session';

// The hourly sign-in check (ADR 063): Cognito not answering says nothing about the session,
// so the person carries on and it is tried again on the next request (for up to a day); a
// rejection still signs them out. The calls to Cognito give up after 5 seconds.

const cognito = { refresh: 'ok' as 'ok' | 'hang' | 'down' | 'rejected' };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/cognito', async (real) => {
  const actual = await real<typeof import('@/lib/auth/cognito')>();
  return {
    ...actual,
    refreshTokens: () => {
      switch (cognito.refresh) {
        case 'ok':
          return Promise.resolve({ idToken: 'id', refreshToken: 'rotated' });
        case 'hang':
          return actual.withinTime(new Promise(() => {}), 50);
        case 'down':
          return Promise.reject(new actual.CognitoUnavailable('COGNITO_TOKEN_503'));
        default:
          return Promise.reject(new Error('COGNITO_TOKEN_400'));
      }
    },
    verifyIdToken: () => Promise.resolve('sub-1'),
  };
});

const { proxy } = await import('../proxy');
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';

/** A request with a Cognito session last checked `ago` seconds back. */
async function request(ago: number) {
  const now = nowSeconds();
  const session = { ...newSession('user-1', 'cognito', now), ref: now - ago };
  const req = new NextRequest('http://localhost:3000/');
  req.cookies.set(SESSION_COOKIE, await signSession(session, SECRET));
  req.cookies.set('oo_refresh', 'refresh-token');
  return req;
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('COGNITO_USER_POOL_ID', 'ap-south-1_customer');
  vi.stubEnv('COGNITO_CLIENT_ID', 'customer-client');
  vi.stubEnv('COGNITO_DOMAIN', 'auth.example.com');
  vi.stubEnv('APP_URL', 'https://app.example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const toLogin = (res: Response) => res.headers.get('location')?.includes('/login') ?? false;

describe('the hourly sign-in check', () => {
  it('passes when Cognito answers', async () => {
    cognito.refresh = 'ok';
    expect(toLogin(await proxy(await request(2 * 60 * 60)))).toBe(false);
  });

  it('lets the person in when Cognito does not answer, and says so in the log', async () => {
    for (const mode of ['hang', 'down'] as const) {
      cognito.refresh = mode;
      const started = Date.now();
      const res = await proxy(await request(2 * 60 * 60));
      expect(toLogin(res), mode).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
      // the check is not marked done, so the next request tries again
      expect(res.cookies.get('oo_refresh')).toBeUndefined();
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cognito_unavailable'));
  });

  it('signs the person out when Cognito says no', async () => {
    cognito.refresh = 'rejected';
    expect(toLogin(await proxy(await request(2 * 60 * 60)))).toBe(true);
  });

  it('signs out after a day without an answer', async () => {
    cognito.refresh = 'down';
    expect(toLogin(await proxy(await request(COGNITO_GRACE_S + 60)))).toBe(true);
  });
});
