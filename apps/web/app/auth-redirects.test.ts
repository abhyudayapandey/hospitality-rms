import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behind Caddy the app listens on 127.0.0.1:3000, so every request reaches it with that
// host. Every redirect the auth routes and the proxy build must still point at APP_URL
// (the B1 bug: a platform sign-in landed on https://localhost:3000/platform).

const APP = 'https://outletops-ap.duckdns.org';
const INTERNAL = 'http://localhost:3000';

const jar = new Map<string, string>();
const limit = { ok: true };
const signIn = { groups: ['platform-admins'], fail: false };

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (c: string | { name: string }) => void jar.delete(typeof c === 'string' ? c : c.name),
    }),
  headers: () => Promise.resolve(new Headers({ origin: APP })),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  LIMITS: { signIn: { limit: 30, windowS: 300 } },
  clientAddress: () => 'test',
  withinLimit: () => Promise.resolve(limit.ok),
}));
vi.mock('@/lib/db', () => ({
  platformSignIn: () =>
    signIn.fail ? Promise.reject(new Error('NOT_AUTHORISED')) : Promise.resolve('admin-1'),
  userIdForCognitoSub: () => Promise.resolve('user-1'),
  withUser: (_uid: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
  sql: () => ({ execute: () => Promise.resolve(undefined) }),
}));
vi.mock('@/lib/auth/cognito', async (real) => ({
  ...(await real<typeof import('@/lib/auth/cognito')>()),
  exchangeCode: (_cfg: unknown, code: string) =>
    code === 'bad'
      ? Promise.reject(new Error('invalid_grant'))
      : Promise.resolve({ idToken: 'id', refreshToken: 'refresh' }),
  verifyIdToken: () => Promise.resolve('sub-1'),
  verifyIdTokenClaims: () =>
    Promise.resolve({ sub: 'sub-1', email: 'admin@example.com', groups: signIn.groups }),
  revokeRefreshToken: () => Promise.resolve(),
}));

const platformLogin = await import('./platform/auth/login/route');
const platformCallback = await import('./platform/auth/callback/route');
const platformLogout = await import('./platform/auth/logout/route');
const platformContinue = await import('./platform/auth/continue/route');
const customerLogin = await import('./auth/login/route');
const customerCallback = await import('./auth/callback/route');
const customerLogout = await import('./auth/logout/route');
const { proxy } = await import('../proxy');

const internal = (path: string, init?: RequestInit) => new Request(`${INTERNAL}${path}`, init);

function location(res: Response): string {
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  const loc = res.headers.get('location');
  expect(loc).toBeTruthy();
  return loc ?? '';
}

/** The redirect goes to APP_URL + path, and never to the internal address. */
function expectApp(res: Response, path: string) {
  const loc = location(res);
  expect(loc).not.toContain('localhost');
  expect(loc).toBe(`${APP}${path}`);
}

/** The redirect goes to Cognito, which is told to return to APP_URL + path. */
function expectCognito(res: Response, param: 'redirect_uri' | 'logout_uri', path: string) {
  const loc = new URL(location(res));
  expect(loc.host).toBe('auth.example.com');
  expect(loc.searchParams.get(param)).toBe(`${APP}${path}`);
  expect(loc.toString()).not.toContain('localhost');
}

function withCognito() {
  vi.stubEnv('COGNITO_USER_POOL_ID', 'ap-south-1_customer');
  vi.stubEnv('COGNITO_CLIENT_ID', 'customer-client');
  vi.stubEnv('COGNITO_DOMAIN', 'auth.example.com');
  vi.stubEnv('PLATFORM_COGNITO_USER_POOL_ID', 'ap-south-1_platform');
  vi.stubEnv('PLATFORM_COGNITO_CLIENT_ID', 'platform-client');
  vi.stubEnv('PLATFORM_COGNITO_DOMAIN', 'auth.example.com');
}

beforeEach(() => {
  jar.clear();
  limit.ok = true;
  signIn.groups = ['platform-admins'];
  signIn.fail = false;
  for (const k of [
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'COGNITO_DOMAIN',
    'PLATFORM_COGNITO_USER_POOL_ID',
    'PLATFORM_COGNITO_CLIENT_ID',
    'PLATFORM_COGNITO_DOMAIN',
  ]) {
    vi.stubEnv(k, '');
  }
  vi.stubEnv('APP_URL', APP);
  vi.stubEnv('SESSION_SECRET', 'test-secret-test-secret-test-secret');
});
afterEach(() => vi.unstubAllEnvs());

describe('platform auth redirects use APP_URL, not the request host', () => {
  it('login: unconfigured, rate limited, and the Cognito round trip', async () => {
    expectApp(
      await platformLogin.GET(internal('/platform/auth/login')),
      '/platform/signin?reason=cognito',
    );
    withCognito();
    limit.ok = false;
    expectApp(
      await platformLogin.GET(internal('/platform/auth/login')),
      '/platform/signin?reason=rate_limited',
    );
    limit.ok = true;
    expectCognito(
      await platformLogin.GET(internal('/platform/auth/login')),
      'redirect_uri',
      '/platform/auth/callback',
    );
  });

  it('callback: every failure and the signed-in landing', async () => {
    withCognito();
    const cb = (q: string) => platformCallback.GET(internal(`/platform/auth/callback${q}`));
    const pkce = () => jar.set('oo_platform_pkce', 'st.verifier');

    limit.ok = false;
    expectApp(await cb('?code=c&state=st'), '/platform/signin?reason=rate_limited');
    limit.ok = true;

    expectApp(await cb('?code=c&state=st'), '/platform/signin?reason=cognito'); // no PKCE cookie
    pkce();
    expectApp(await cb('?code=c&state=other'), '/platform/signin?reason=cognito');
    pkce();
    expectApp(await cb('?code=bad&state=st'), '/platform/signin?reason=cognito');
    pkce();
    signIn.groups = [];
    expectApp(await cb('?code=c&state=st'), '/platform/signin?reason=not_platform_admin');
    signIn.groups = ['platform-admins'];
    pkce();
    signIn.fail = true;
    expectApp(await cb('?code=c&state=st'), '/platform/signin?reason=not_platform_admin');
    signIn.fail = false;

    pkce();
    expectApp(await cb('?code=c&state=st'), '/platform/auth/continue');
    expect(jar.has('oo_platform')).toBe(true);
  });

  it('logout: to signed-out directly, or via the pool', async () => {
    const out = () => platformLogout.POST();
    expectApp(await out(), '/platform/signed-out');
    withCognito();
    expectCognito(await out(), 'logout_uri', '/platform/signed-out');
  });

  it('proxy: /platform without a platform session goes to the platform sign-in', async () => {
    const res = await proxy(new NextRequest(`${INTERNAL}/platform`));
    expectApp(res, '/platform/signin?reason=invalid');
  });
});

describe('customer auth redirects use APP_URL, not the request host', () => {
  it('login', async () => {
    expectApp(await customerLogin.GET(internal('/auth/login')), '/login?reason=cognito');
    withCognito();
    limit.ok = false;
    expectApp(await customerLogin.GET(internal('/auth/login')), '/login?reason=rate_limited');
    limit.ok = true;
    expectCognito(
      await customerLogin.GET(internal('/auth/login')),
      'redirect_uri',
      '/auth/callback',
    );
  });

  it('callback', async () => {
    withCognito();
    const cb = (q: string) => customerCallback.GET(internal(`/auth/callback${q}`));
    expectApp(await cb('?code=c&state=st'), '/login?reason=cognito');
    jar.set('oo_pkce', 'st.verifier');
    expectApp(await cb('?code=bad&state=st'), '/login?reason=cognito');
    jar.set('oo_pkce', 'st.verifier');
    expectApp(await cb('?code=c&state=st'), '/');
  });

  it('logout without a Cognito session: a relative /login', async () => {
    withCognito();
    const res = await customerLogout.POST();
    const { redirect } = (await res.json()) as { redirect: string };
    expect(redirect).toBe('/login'); // relative: resolved by the browser on the public host
  });

  it('proxy: no session goes to /login', async () => {
    expectApp(await proxy(new NextRequest(`${INTERNAL}/requests`)), '/login?reason=signin');
  });
});

describe('platform continue page', () => {
  it('moves on to APP_URL/platform from our own site, with no input', async () => {
    const res = platformContinue.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${APP}/platform">`);
    expect(html).not.toContain('localhost');
  });
});

describe('appUrl', () => {
  it('joins paths onto APP_URL and refuses to guess without it', async () => {
    const { appUrl } = await import('@/lib/app-url');
    expect(appUrl('/platform', { APP_URL: `${APP}/` }).toString()).toBe(`${APP}/platform`);
    expect(appUrl('/login?reason=x', { APP_URL: APP }).toString()).toBe(`${APP}/login?reason=x`);
    expect(() => appUrl('/', {})).toThrow('APP_URL is not set');
  });
});
