import { cognitoCall, CognitoRefused, type CognitoConfig, type TokenSet } from './cognito';

// Our own sign-in screen (ADR 161) talks to Cognito's user API as the public Web client:
// the password or an emailed code (USER_AUTH, the pool's first factors), the new password
// a first sign-in asks for, and Forgot password. Cognito keeps the passwords, the policy
// and the lockout; the app only passes them through and never stores or logs them.

/** Where a sign-in stands after one step. */
export type SignInStep =
  | { kind: 'signed_in'; tokens: TokenSet }
  /** a first sign-in with a temporary password: choose your own */
  | { kind: 'new_password'; session: string }
  /** a code was emailed; `to` is the masked address Cognito names */
  | { kind: 'email_code'; session: string; to: string | null }
  /** wrong login or password, or a wrong or expired code (Cognito says which, we don't) */
  | { kind: 'wrong' }
  /** the password must be reset first (an admin asked for it) */
  | { kind: 'reset_required' }
  /** this login has no way to get a code by email */
  | { kind: 'no_email' }
  /** the new password does not meet the pool's policy */
  | { kind: 'weak_password' }
  /** Cognito's own limit on attempts */
  | { kind: 'too_many' };

interface AuthOut {
  AuthenticationResult?: { IdToken?: string; RefreshToken?: string };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
  AvailableChallenges?: string[];
}

function outcome(out: AuthOut): SignInStep {
  const id = out.AuthenticationResult?.IdToken;
  if (id) {
    const refresh = out.AuthenticationResult?.RefreshToken;
    return {
      kind: 'signed_in',
      tokens: { idToken: id, ...(refresh ? { refreshToken: refresh } : {}) },
    };
  }
  if (out.ChallengeName === 'NEW_PASSWORD_REQUIRED' && out.Session) {
    return { kind: 'new_password', session: out.Session };
  }
  if (out.ChallengeName === 'EMAIL_OTP' && out.Session) {
    return {
      kind: 'email_code',
      session: out.Session,
      to: out.ChallengeParameters?.CODE_DELIVERY_DESTINATION ?? null,
    };
  }
  // SELECT_CHALLENGE without EMAIL_OTP, or anything else: no code can be sent this way
  return { kind: 'no_email' };
}

function refused(err: unknown): SignInStep {
  if (!(err instanceof CognitoRefused)) throw err;
  switch (err.type) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
    case 'CodeMismatchException':
    case 'ExpiredCodeException':
      return { kind: 'wrong' };
    case 'PasswordResetRequiredException':
      return { kind: 'reset_required' };
    case 'InvalidPasswordException':
      return { kind: 'weak_password' };
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return { kind: 'too_many' };
    case 'InvalidParameterException':
    case 'UnsupportedOperationException':
      return { kind: 'no_email' };
    default:
      throw err;
  }
}

async function step(
  cfg: CognitoConfig,
  action: 'InitiateAuth' | 'RespondToAuthChallenge',
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<SignInStep> {
  try {
    return outcome(
      await cognitoCall<AuthOut>(cfg, action, { ClientId: cfg.clientId, ...body }, fetchImpl),
    );
  } catch (err) {
    return refused(err);
  }
}

/** The login (username or email) and password. */
export function signInWithPassword(
  cfg: CognitoConfig,
  login: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInStep> {
  return step(
    cfg,
    'InitiateAuth',
    {
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: login, PASSWORD: password, PREFERRED_CHALLENGE: 'PASSWORD' },
    },
    fetchImpl,
  );
}

/** Asks Cognito to email a one-time code to the login's verified address. */
export function sendEmailCode(
  cfg: CognitoConfig,
  login: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInStep> {
  return step(
    cfg,
    'InitiateAuth',
    {
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: login, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
    },
    fetchImpl,
  );
}

/** The code from the email. */
export function answerEmailCode(
  cfg: CognitoConfig,
  login: string,
  session: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInStep> {
  return step(
    cfg,
    'RespondToAuthChallenge',
    {
      ChallengeName: 'EMAIL_OTP',
      Session: session,
      ChallengeResponses: { USERNAME: login, EMAIL_OTP_CODE: code },
    },
    fetchImpl,
  );
}

/** A first sign-in's own password, replacing the temporary one. */
export function chooseNewPassword(
  cfg: CognitoConfig,
  login: string,
  session: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInStep> {
  return step(
    cfg,
    'RespondToAuthChallenge',
    {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: login, NEW_PASSWORD: password },
    },
    fetchImpl,
  );
}

/** Forgot password: Cognito emails a code (an unknown login looks the same, by design). */
export async function startPasswordReset(
  cfg: CognitoConfig,
  login: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: 'code_sent'; to: string | null } | SignInStep> {
  try {
    const out = await cognitoCall<{ CodeDeliveryDetails?: { Destination?: string } }>(
      cfg,
      'ForgotPassword',
      { ClientId: cfg.clientId, Username: login },
      fetchImpl,
    );
    return { kind: 'code_sent', to: out.CodeDeliveryDetails?.Destination ?? null };
  } catch (err) {
    return refused(err);
  }
}

/** The emailed code and the new password. */
export async function finishPasswordReset(
  cfg: CognitoConfig,
  login: string,
  code: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: 'reset_done' } | SignInStep> {
  try {
    await cognitoCall(
      cfg,
      'ConfirmForgotPassword',
      { ClientId: cfg.clientId, Username: login, ConfirmationCode: code, Password: password },
      fetchImpl,
    );
    return { kind: 'reset_done' };
  } catch (err) {
    return refused(err);
  }
}
