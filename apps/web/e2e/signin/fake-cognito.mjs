// A stand-in for Cognito's user API, for the sign-in e2e tests only (ADR 161). The app under
// test is pointed here with COGNITO_IDP_ENDPOINT (accepted only on this machine); the live
// app always talks to Cognito itself. It answers the calls the sign-in screen makes, the way
// Cognito does, for a few made-up logins, and signs ID tokens with its own key, published at
// /.well-known/jwks.json for the app to check them with.
//
//   gm.signin        password Right-pass-123                     -> signed in
//   new.signin       temporary password Temp-pass-123            -> choose a new password
//   code@signin.test emailed code 246810                         -> signed in
//   gm.signin        Forgot password: code 135790 + new password -> password changed
//
// POST /__reset puts every password back. Env: FAKE_COGNITO_PORT (default 3109).

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import process from 'node:process';

export const POOL = 'ap-south-1_E2eSignIn';
export const CLIENT = 'e2e-web-client';
export const SUBS = {
  'gm.signin': '00000000-0000-4000-8000-0000000000a1',
  'new.signin': '00000000-0000-4000-8000-0000000000a2',
  'code@signin.test': '00000000-0000-4000-8000-0000000000a3',
};
const EMAIL_CODE = '246810';
const RESET_CODE = '135790';
const START = { 'gm.signin': 'Right-pass-123', 'new.signin': 'Temp-pass-123' };
const TEMPORARY = new Set(['new.signin']);

let passwords = { ...START };
let temporary = new Set(TEMPORARY);
const sessions = new Map(); // Cognito's Session string -> login

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = publicKey.export({ format: 'jwk' });
const jwks = {
  keys: [{ kty: 'RSA', n: pub.n, e: pub.e, kid: 'e2e-kid', alg: 'RS256', use: 'sig' }],
};

function idToken(login) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', kid: 'e2e-kid', typ: 'JWT' });
  const body = enc({
    sub: SUBS[login],
    iss: `https://cognito-idp.ap-south-1.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    ...(login.includes('@') ? { email: login } : {}),
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const tokens = (login) => ({
  AuthenticationResult: { IdToken: idToken(login), RefreshToken: `refresh-${login}` },
});
const refuse = (type) => ({ status: 400, body: { __type: type, message: type } });
function session(login) {
  const s = randomUUID();
  sessions.set(s, login);
  return s;
}

function answer(action, req) {
  if (req.ClientId !== CLIENT) return refuse('ResourceNotFoundException');
  if (action === 'InitiateAuth' && req.AuthFlow === 'USER_AUTH') {
    const p = req.AuthParameters ?? {};
    const login = p.USERNAME;
    if (p.PREFERRED_CHALLENGE === 'EMAIL_OTP') {
      if (!SUBS[login] || !login.includes('@')) {
        return {
          body: {
            ChallengeName: 'SELECT_CHALLENGE',
            Session: 'x',
            AvailableChallenges: ['PASSWORD'],
          },
        };
      }
      return {
        body: {
          ChallengeName: 'EMAIL_OTP',
          Session: session(login),
          ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'c***@s***' },
        },
      };
    }
    if (!passwords[login] || passwords[login] !== p.PASSWORD)
      return refuse('NotAuthorizedException');
    if (temporary.has(login)) {
      return { body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: session(login) } };
    }
    return { body: tokens(login) };
  }
  if (action === 'InitiateAuth' && req.AuthFlow === 'REFRESH_TOKEN_AUTH') {
    const login = String(req.AuthParameters?.REFRESH_TOKEN ?? '').replace(/^refresh-/, '');
    return SUBS[login]
      ? { body: { AuthenticationResult: { IdToken: idToken(login) } } }
      : refuse('NotAuthorizedException');
  }
  if (action === 'RespondToAuthChallenge') {
    const login = sessions.get(req.Session);
    const r = req.ChallengeResponses ?? {};
    if (!login || login !== r.USERNAME) return refuse('NotAuthorizedException');
    if (req.ChallengeName === 'EMAIL_OTP') {
      return r.EMAIL_OTP_CODE === EMAIL_CODE
        ? { body: tokens(login) }
        : refuse('CodeMismatchException');
    }
    if (req.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      if (String(r.NEW_PASSWORD ?? '').length < 10) return refuse('InvalidPasswordException');
      passwords[login] = r.NEW_PASSWORD;
      temporary.delete(login);
      sessions.delete(req.Session);
      return { body: tokens(login) };
    }
  }
  if (action === 'ForgotPassword') {
    return { body: { CodeDeliveryDetails: { Destination: 'g***@s***' } } };
  }
  if (action === 'ConfirmForgotPassword') {
    if (req.ConfirmationCode !== RESET_CODE || !passwords[req.Username])
      return refuse('CodeMismatchException');
    if (String(req.Password ?? '').length < 10) return refuse('InvalidPasswordException');
    passwords[req.Username] = req.Password;
    return { body: {} };
  }
  return refuse('InvalidParameterException');
}

const port = Number(process.env.FAKE_COGNITO_PORT ?? 3109);
createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/.well-known/jwks.json') return send(200, jwks);
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url === '/__reset') {
      passwords = { ...START };
      temporary = new Set(TEMPORARY);
      sessions.clear();
      return send(200, {});
    }
    const action = String(req.headers['x-amz-target'] ?? '')
      .split('.')
      .pop();
    const { status = 200, body } = answer(action, JSON.parse(raw || '{}'));
    send(status, body);
  });
}).listen(port, '127.0.0.1');
