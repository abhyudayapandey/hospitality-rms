import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Amazon Cognito (ADR 004). People sign in on our own screen, which calls Cognito's user
// API (ADR 161); the Hosted UI code flow with PKCE stays for the team console and as a
// fallback. The app is a public client (no secret).

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  /** Hosted UI domain, e.g. outlet-ops.auth.ap-south-1.amazoncognito.com */
  domain: string;
  appUrl: string;
  /** Where Cognito returns; default /auth/callback (the platform pool uses its own). */
  callbackPath?: string;
  /** Where sign-out lands; default /login. */
  logoutPath?: string;
  /** OAuth scopes; default 'openid phone email'. */
  scope?: string;
  /**
   * Tests only: a stand-in for Cognito's user API on this machine (COGNITO_IDP_ENDPOINT,
   * http://127.0.0.1 or localhost only; the sign-in e2e tests, ADR 161). Unset everywhere
   * else, so the app always talks to Cognito itself.
   */
  idpEndpoint?: string;
}

/** COGNITO_IDP_ENDPOINT, accepted only when it points at this machine. */
export function localIdpEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('COGNITO_IDP_ENDPOINT must be http://127.0.0.1 or http://localhost');
  }
  return url.origin;
}

export function cognitoConfig(
  env: Record<string, string | undefined> = process.env,
): CognitoConfig | null {
  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN, APP_URL } = env;
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID || !COGNITO_DOMAIN || !APP_URL) return null;
  const idpEndpoint = localIdpEndpoint(env.COGNITO_IDP_ENDPOINT);
  return {
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID,
    domain: COGNITO_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appUrl: APP_URL.replace(/\/$/, ''),
    ...(idpEndpoint ? { idpEndpoint } : {}),
  };
}

export function redirectUri(cfg: CognitoConfig): string {
  return `${cfg.appUrl}${cfg.callbackPath ?? '/auth/callback'}`;
}

export function authorizeUrl(cfg: CognitoConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: cfg.scope ?? 'openid phone email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `https://${cfg.domain}/oauth2/authorize?${q}`;
}

export function logoutUrl(cfg: CognitoConfig): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: `${cfg.appUrl}${cfg.logoutPath ?? '/login'}`,
  });
  return `https://${cfg.domain}/logout?${q}`;
}

const verifiers = new Map<string, ReturnType<typeof createIdTokenVerifier>>();

export function createIdTokenVerifier(cfg: Pick<CognitoConfig, 'userPoolId' | 'clientId'>) {
  return CognitoJwtVerifier.create({
    userPoolId: cfg.userPoolId,
    tokenUse: 'id',
    clientId: cfg.clientId,
  });
}

/** Verifies a Cognito ID token (signature, issuer, audience, expiry) and returns its sub. */
export async function verifyIdToken(cfg: CognitoConfig, idToken: string): Promise<string> {
  return (await verifyIdTokenClaims(cfg, idToken)).sub;
}

export interface IdTokenClaims {
  sub: string;
  email: string | null;
  groups: string[];
}

/** Verifies a Cognito ID token and returns the claims the app uses (groups for platform). */
export async function verifyIdTokenClaims(
  cfg: CognitoConfig,
  idToken: string,
): Promise<IdTokenClaims> {
  let v = verifiers.get(cfg.userPoolId + cfg.clientId);
  if (!v) {
    v = createIdTokenVerifier(cfg);
    // tests only: the stand-in's signing keys, in place of Cognito's published ones
    if (cfg.idpEndpoint) {
      const res = await fetch(`${cfg.idpEndpoint}/.well-known/jwks.json`);
      v.cacheJwks((await res.json()) as Parameters<typeof v.cacheJwks>[0]);
    }
    verifiers.set(cfg.userPoolId + cfg.clientId, v);
  }
  const payload = await v.verify(idToken);
  const groups = payload['cognito:groups'];
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
  };
}

export interface TokenSet {
  idToken: string;
  refreshToken?: string;
}

/** How long a call to Cognito may take before it counts as not answering (ADR 063). */
export const COGNITO_TIMEOUT_MS = 5000;

/**
 * Cognito did not answer: no connection, a timeout or a server error. Unlike a rejection
 * (a refresh token revoked or expired), it says nothing about the session (ADR 063).
 */
export class CognitoUnavailable extends Error {}

/** Resolves with `p`, or rejects with CognitoUnavailable after `ms`. */
export function withinTime<T>(p: Promise<T>, ms = COGNITO_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CognitoUnavailable(`no answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function tokenRequest(
  cfg: CognitoConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await withinTime(
      fetchImpl(`https://${cfg.domain}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, ...body }),
        signal: AbortSignal.timeout(COGNITO_TIMEOUT_MS),
      }),
    );
  } catch (err) {
    throw err instanceof CognitoUnavailable
      ? err
      : new CognitoUnavailable(err instanceof Error ? err.name : 'fetch failed');
  }
  if (res.status >= 500 || res.status === 429) {
    throw new CognitoUnavailable(`COGNITO_TOKEN_${res.status}`);
  }
  if (!res.ok) throw new Error(`COGNITO_TOKEN_${res.status}`);
  const json = (await res.json()) as { id_token?: string; refresh_token?: string };
  if (!json.id_token) throw new Error('COGNITO_TOKEN_NO_ID_TOKEN');
  return {
    idToken: json.id_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
  };
}

export function exchangeCode(
  cfg: CognitoConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(cfg),
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
}

/** Cognito refused the call (a wrong password, an expired code); `type` is its exception name. */
export class CognitoRefused extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One call to Cognito's user API (cognito-idp) as the public Web client: no AWS credentials,
 * only the client id (ADR 161). Throws CognitoRefused for an answer that says no, and
 * CognitoUnavailable when Cognito does not answer in time or fails on its side (ADR 063).
 */
export async function cognitoCall<T>(
  cfg: Pick<CognitoConfig, 'userPoolId' | 'idpEndpoint'>,
  action: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const region = cfg.userPoolId.split('_')[0];
  let res: Response;
  try {
    res = await withinTime(
      fetchImpl(
        cfg.idpEndpoint ? `${cfg.idpEndpoint}/` : `https://cognito-idp.${region}.amazonaws.com/`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(COGNITO_TIMEOUT_MS),
        },
      ),
    );
  } catch (err) {
    throw err instanceof CognitoUnavailable
      ? err
      : new CognitoUnavailable(err instanceof Error ? err.name : 'fetch failed');
  }
  if (res.status >= 500) throw new CognitoUnavailable(`COGNITO_${action}_${res.status}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const raw = json.__type ?? json.code;
    const type = (typeof raw === 'string' ? raw : 'Unknown').split('#').pop()!;
    if (type === 'TooManyRequestsException' || type === 'InternalErrorException') {
      throw new CognitoUnavailable(`COGNITO_${action}_${type}`);
    }
    throw new CognitoRefused(type, `COGNITO_${action}_${type}`);
  }
  return json as T;
}

/**
 * Server-side refresh (REFRESH_TOKEN_AUTH on the Web client), for a session started on
 * our own sign-in screen or on Cognito's page alike (ADR 161). A refused refresh token
 * throws; Cognito not answering throws CognitoUnavailable (ADR 063).
 */
export async function refreshTokens(
  cfg: CognitoConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const out = await cognitoCall<{
    AuthenticationResult?: { IdToken?: string; RefreshToken?: string };
  }>(
    cfg,
    'InitiateAuth',
    {
      ClientId: cfg.clientId,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    },
    fetchImpl,
  );
  const id = out.AuthenticationResult?.IdToken;
  if (!id) throw new Error('COGNITO_REFRESH_NO_ID_TOKEN');
  const next = out.AuthenticationResult?.RefreshToken;
  return { idToken: id, ...(next ? { refreshToken: next } : {}) };
}

export async function revokeRefreshToken(
  cfg: CognitoConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(`https://${cfg.domain}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, client_id: cfg.clientId }),
  });
}
