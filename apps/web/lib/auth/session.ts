// Signed session cookie (ADR 004). Pure Web Crypto so it runs in the proxy, route
// handlers and tests alike. The cookie carries only the user id and timestamps; the
// user is re-checked against core.me() on every request.

export const SESSION_COOKIE = 'oo_session';
export const REFRESH_COOKIE = 'oo_refresh';
export const NODE_COOKIE = 'oo_node';
export const PKCE_COOKIE = 'oo_pkce';

export const IDLE_TIMEOUT_S = 12 * 60 * 60; // 12 h without activity
export const ABSOLUTE_TIMEOUT_S = 30 * 24 * 60 * 60; // 30 days from sign-in
export const TOUCH_AFTER_S = 5 * 60; // re-issue the cookie at most every 5 min
export const COGNITO_REFRESH_AFTER_S = 60 * 60; // re-validate with Cognito hourly

export interface SessionPayload {
  v: 1;
  uid: string;
  src: 'dev' | 'cognito';
  /** issued at (s) */
  iat: number;
  /** last seen (s), for the idle timeout */
  seen: number;
  /** last Cognito refresh (s) */
  ref: number;
}

export type VerifyResult =
  { ok: true; payload: SessionPayload } | { ok: false; reason: 'invalid' | 'idle' | 'absolute' };

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function newSession(
  uid: string,
  src: SessionPayload['src'],
  now = nowSeconds(),
): SessionPayload {
  return { v: 1, uid, src, iat: now, seen: now, ref: now };
}

/** A signed token: base64url JSON body, dot, HMAC-SHA256 of the body. */
export async function signToken(payload: object, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/** The token's JSON body when its signature is valid, else null. */
export async function verifyToken(token: string | undefined, secret: string): Promise<unknown> {
  if (!token) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      fromB64url(sig),
      enc.encode(body),
    );
    return valid ? (JSON.parse(new TextDecoder().decode(fromB64url(body))) as unknown) : null;
  } catch {
    return null;
  }
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  return signToken(payload, secret);
}

export async function verifySession(
  token: string | undefined,
  secret: string,
  now = nowSeconds(),
): Promise<VerifyResult> {
  const payload = (await verifyToken(token, secret)) as SessionPayload | null;
  if (!payload) return { ok: false, reason: 'invalid' };
  if (payload.v !== 1 || typeof payload.uid !== 'string') return { ok: false, reason: 'invalid' };
  if (now - payload.iat > ABSOLUTE_TIMEOUT_S) return { ok: false, reason: 'absolute' };
  if (now - payload.seen > IDLE_TIMEOUT_S) return { ok: false, reason: 'idle' };
  return { ok: true, payload };
}

/** Cookie max-age: until the absolute timeout. */
export function sessionMaxAge(payload: SessionPayload, now = nowSeconds()): number {
  return Math.max(0, payload.iat + ABSOLUTE_TIMEOUT_S - now);
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}
