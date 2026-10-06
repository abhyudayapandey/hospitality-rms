import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  COGNITO_TIMEOUT_MS,
  CognitoUnavailable,
  authorizeUrl,
  cognitoConfig,
  createIdTokenVerifier,
  exchangeCode,
  logoutUrl,
  refreshTokens,
  type CognitoConfig,
} from './cognito';

const cfg: CognitoConfig = {
  userPoolId: 'ap-south-1_TestPool1',
  clientId: 'client123',
  domain: 'outlet-ops.auth.ap-south-1.amazoncognito.com',
  appUrl: 'https://app.example.com',
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = publicKey.export({ format: 'jwk' });
const jwk = { kty: 'RSA', n: pub.n!, e: pub.e!, kid: 'test-kid', alg: 'RS256', use: 'sig' };

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const body = enc(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function idToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt({
    sub: 'sub-123',
    iss: `https://cognito-idp.ap-south-1.amazonaws.com/${cfg.userPoolId}`,
    aud: cfg.clientId,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
}

describe('Cognito ID token verification (aws-jwt-verify)', () => {
  const verifier = createIdTokenVerifier(cfg);
  verifier.cacheJwks({ keys: [jwk] });

  it('accepts a valid ID token and exposes its sub', async () => {
    expect((await verifier.verify(idToken())).sub).toBe('sub-123');
  });

  it('rejects wrong audience, issuer, token use, expiry and signature', async () => {
    await expect(verifier.verify(idToken({ aud: 'other' }))).rejects.toThrow();
    await expect(verifier.verify(idToken({ iss: 'https://evil.example.com' }))).rejects.toThrow();
    await expect(verifier.verify(idToken({ token_use: 'access' }))).rejects.toThrow();
    await expect(
      verifier.verify(idToken({ exp: Math.floor(Date.now() / 1000) - 10 })),
    ).rejects.toThrow();
    const t = idToken().split('.');
    await expect(verifier.verify(`${t[0]}.${t[1]}.${t[2]!.slice(0, -4)}AAAA`)).rejects.toThrow();
  });
});

describe('Cognito config and OAuth calls', () => {
  it('is disabled unless fully configured', () => {
    expect(cognitoConfig({ COGNITO_USER_POOL_ID: 'x', COGNITO_CLIENT_ID: 'y' })).toBeNull();
    expect(
      cognitoConfig({
        COGNITO_USER_POOL_ID: cfg.userPoolId,
        COGNITO_CLIENT_ID: cfg.clientId,
        COGNITO_DOMAIN: `https://${cfg.domain}/`,
        APP_URL: 'https://app.example.com/',
      }),
    ).toEqual(cfg);
  });

  it('builds a PKCE authorize URL and a logout URL', () => {
    const u = new URL(authorizeUrl(cfg, 'st4te', 'ch4llenge'));
    expect(u.origin).toBe(`https://${cfg.domain}`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client123',
      redirect_uri: 'https://app.example.com/auth/callback',
      state: 'st4te',
      code_challenge: 'ch4llenge',
      code_challenge_method: 'S256',
    });
    expect(logoutUrl(cfg)).toContain('logout_uri=https%3A%2F%2Fapp.example.com%2Flogin');
  });

  it('exchanges a code with the PKCE verifier', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ id_token: 'id', refresh_token: 'r1' })),
    );
    expect(await exchangeCode(cfg, 'code1', 'verif', fetchMock)).toEqual({
      idToken: 'id',
      refreshToken: 'r1',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${cfg.domain}/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(init.body as URLSearchParams))).toEqual({
      client_id: 'client123',
      grant_type: 'authorization_code',
      code: 'code1',
      redirect_uri: 'https://app.example.com/auth/callback',
      code_verifier: 'verif',
    });
  });

  it('refreshes server-side and returns a rotated refresh token when Cognito sends one', async () => {
    const rotated = vi.fn(() =>
      Promise.resolve(Response.json({ id_token: 'id2', refresh_token: 'r2' })),
    );
    expect(await refreshTokens(cfg, 'r1', rotated)).toEqual({ idToken: 'id2', refreshToken: 'r2' });
    const notRotated = vi.fn(() => Promise.resolve(Response.json({ id_token: 'id3' })));
    expect(await refreshTokens(cfg, 'r1', notRotated)).toEqual({ idToken: 'id3' });
    const failed = vi.fn(() => Promise.resolve(new Response('{}', { status: 400 })));
    await expect(refreshTokens(cfg, 'revoked', failed)).rejects.toThrow('COGNITO_TOKEN_400');
  });
});

describe('Cognito not answering (ADR 063)', () => {
  const cfg = { userPoolId: 'ap-south-1_x', clientId: 'c', domain: 'auth.example.com' };

  it('gives up after 5 seconds and says Cognito is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const never: typeof fetch = () => new Promise(() => {});
      const p = refreshTokens(cfg as never, 'r', never);
      const check = expect(p).rejects.toBeInstanceOf(CognitoUnavailable);
      await vi.advanceTimersByTimeAsync(COGNITO_TIMEOUT_MS + 1);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server error is unavailable; a rejection is not', async () => {
    const answer =
      (status: number): typeof fetch =>
      () =>
        Promise.resolve(new Response('{}', { status }));
    await expect(refreshTokens(cfg as never, 'r', answer(503))).rejects.toBeInstanceOf(
      CognitoUnavailable,
    );
    const rejected = refreshTokens(cfg as never, 'r', answer(400));
    await expect(rejected).rejects.toThrow('COGNITO_TOKEN_400');
    await expect(rejected).rejects.not.toBeInstanceOf(CognitoUnavailable);
  });
});
