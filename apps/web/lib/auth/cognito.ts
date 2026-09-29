import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Amazon Cognito Hosted UI, OAuth code flow with PKCE (ADR 004). Frontline staff sign
// in with phone OTP configured on the user pool. The app is a public client (no secret).

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  /** Hosted UI domain, e.g. outlet-ops.auth.ap-south-1.amazoncognito.com */
  domain: string;
  appUrl: string;
}

export function cognitoConfig(
  env: Record<string, string | undefined> = process.env,
): CognitoConfig | null {
  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN, APP_URL } = env;
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID || !COGNITO_DOMAIN || !APP_URL) return null;
  return {
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID,
    domain: COGNITO_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appUrl: APP_URL.replace(/\/$/, ''),
  };
}

export function redirectUri(cfg: CognitoConfig): string {
  return `${cfg.appUrl}/auth/callback`;
}

export function authorizeUrl(cfg: CognitoConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: 'openid phone email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `https://${cfg.domain}/oauth2/authorize?${q}`;
}

export function logoutUrl(cfg: CognitoConfig): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: `${cfg.appUrl}/login` });
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
  let v = verifiers.get(cfg.userPoolId + cfg.clientId);
  if (!v) {
    v = createIdTokenVerifier(cfg);
    verifiers.set(cfg.userPoolId + cfg.clientId, v);
  }
  const payload = await v.verify(idToken);
  return payload.sub;
}

export interface TokenSet {
  idToken: string;
  refreshToken?: string;
}

async function tokenRequest(
  cfg: CognitoConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(`https://${cfg.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body }),
  });
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

/**
 * Server-side refresh. With refresh-token rotation enabled on the app client, Cognito
 * returns a new refresh token, which the caller must store.
 */
export function refreshTokens(
  cfg: CognitoConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
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
