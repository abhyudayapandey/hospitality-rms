import { describe, expect, it, vi } from 'vitest';
import { CognitoUnavailable, type CognitoConfig } from './cognito';
import {
  answerEmailCode,
  chooseNewPassword,
  finishPasswordReset,
  sendEmailCode,
  signInWithPassword,
  startPasswordReset,
} from './sign-in';

// Our own sign-in screen's calls to Cognito's user API (ADR 161), against a fake Cognito.

const cfg: CognitoConfig = {
  userPoolId: 'ap-south-1_Pool',
  clientId: 'web-client',
  domain: 'x.auth.ap-south-1.amazoncognito.com',
  appUrl: 'https://app.example.com',
};

function cognito(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));
}
function sent(f: ReturnType<typeof cognito>) {
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    target: (init.headers as Record<string, string>)['x-amz-target'],
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

describe('password sign-in', () => {
  it('asks Cognito with USER_AUTH and the PASSWORD challenge, and returns the tokens', async () => {
    const f = cognito(200, { AuthenticationResult: { IdToken: 'id', RefreshToken: 'rt' } });
    expect(await signInWithPassword(cfg, 'test.chef', 'pw-123456789', f)).toEqual({
      kind: 'signed_in',
      tokens: { idToken: 'id', refreshToken: 'rt' },
    });
    const s = sent(f);
    expect(s.url).toBe('https://cognito-idp.ap-south-1.amazonaws.com/');
    expect(s.target).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(s.body).toEqual({
      ClientId: 'web-client',
      AuthFlow: 'USER_AUTH',
      AuthParameters: {
        USERNAME: 'test.chef',
        PASSWORD: 'pw-123456789',
        PREFERRED_CHALLENGE: 'PASSWORD',
      },
    });
  });

  it('a temporary password asks for a new one; a wrong one says wrong, never which part', async () => {
    const first = cognito(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's1' });
    expect(await signInWithPassword(cfg, 'new.person', 'Temp1234', first)).toEqual({
      kind: 'new_password',
      session: 's1',
    });
    for (const type of ['NotAuthorizedException', 'UserNotFoundException']) {
      const f = cognito(400, { __type: type, message: 'no' });
      expect(await signInWithPassword(cfg, 'x', 'y', f)).toEqual({ kind: 'wrong' });
    }
    const reset = cognito(400, { __type: 'PasswordResetRequiredException' });
    expect(await signInWithPassword(cfg, 'x', 'y', reset)).toEqual({ kind: 'reset_required' });
    const many = cognito(400, { __type: 'LimitExceededException' });
    expect(await signInWithPassword(cfg, 'x', 'y', many)).toEqual({ kind: 'too_many' });
  });

  it('Cognito failing or slow is unavailable, not a wrong password (ADR 063)', async () => {
    await expect(signInWithPassword(cfg, 'x', 'y', cognito(503, {}))).rejects.toBeInstanceOf(
      CognitoUnavailable,
    );
    await expect(
      signInWithPassword(cfg, 'x', 'y', cognito(400, { __type: 'TooManyRequestsException' })),
    ).rejects.toBeInstanceOf(CognitoUnavailable);
  });

  it('an answer it does not know is an error, never a sign-in', async () => {
    await expect(
      signInWithPassword(cfg, 'x', 'y', cognito(400, { __type: 'ResourceNotFoundException' })),
    ).rejects.toThrow('ResourceNotFoundException');
    expect(await signInWithPassword(cfg, 'x', 'y', cognito(200, {}))).toEqual({
      kind: 'no_email',
    });
  });
});

describe('email code sign-in', () => {
  it('sends a code, then answers it with the session', async () => {
    const send = cognito(200, {
      ChallengeName: 'EMAIL_OTP',
      Session: 's2',
      ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
    });
    expect(await sendEmailCode(cfg, 'a@example.com', send)).toEqual({
      kind: 'email_code',
      session: 's2',
      to: 'a***@e***',
    });
    expect(sent(send).body).toEqual({
      ClientId: 'web-client',
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: 'a@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' },
    });

    const answer = cognito(200, { AuthenticationResult: { IdToken: 'id' } });
    expect(await answerEmailCode(cfg, 'a@example.com', 's2', '123456', answer)).toEqual({
      kind: 'signed_in',
      tokens: { idToken: 'id' },
    });
    expect(sent(answer).target).toBe('AWSCognitoIdentityProviderService.RespondToAuthChallenge');
    expect(sent(answer).body).toEqual({
      ClientId: 'web-client',
      ChallengeName: 'EMAIL_OTP',
      Session: 's2',
      ChallengeResponses: { USERNAME: 'a@example.com', EMAIL_OTP_CODE: '123456' },
    });
  });

  it('a login with no email gets no code; a wrong or old code says wrong', async () => {
    const choose = cognito(200, {
      ChallengeName: 'SELECT_CHALLENGE',
      Session: 's',
      AvailableChallenges: ['PASSWORD'],
    });
    expect(await sendEmailCode(cfg, 'test.steward', choose)).toEqual({ kind: 'no_email' });
    for (const type of ['CodeMismatchException', 'ExpiredCodeException']) {
      const f = cognito(400, { __type: type });
      expect(await answerEmailCode(cfg, 'a', 's', '1', f)).toEqual({ kind: 'wrong' });
    }
  });
});

describe('first sign-in and forgot password', () => {
  it('sets the new password with the session', async () => {
    const f = cognito(200, { AuthenticationResult: { IdToken: 'id', RefreshToken: 'rt' } });
    expect(await chooseNewPassword(cfg, 'new.person', 's1', 'mynewpass12', f)).toMatchObject({
      kind: 'signed_in',
    });
    expect(sent(f).body).toEqual({
      ClientId: 'web-client',
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 's1',
      ChallengeResponses: { USERNAME: 'new.person', NEW_PASSWORD: 'mynewpass12' },
    });
    const weak = cognito(400, { __type: 'InvalidPasswordException' });
    expect(await chooseNewPassword(cfg, 'n', 's', 'short', weak)).toEqual({
      kind: 'weak_password',
    });
  });

  it('emails a reset code, then sets the new password', async () => {
    const start = cognito(200, { CodeDeliveryDetails: { Destination: 'o***@e***' } });
    expect(await startPasswordReset(cfg, 'owner@example.com', start)).toEqual({
      kind: 'code_sent',
      to: 'o***@e***',
    });
    expect(sent(start).target).toBe('AWSCognitoIdentityProviderService.ForgotPassword');
    const noEmail = cognito(400, { __type: 'InvalidParameterException' });
    expect(await startPasswordReset(cfg, 'test.steward', noEmail)).toEqual({ kind: 'no_email' });

    const done = cognito(200, {});
    expect(
      await finishPasswordReset(cfg, 'owner@example.com', '123456', 'newpass1234', done),
    ).toEqual({ kind: 'reset_done' });
    expect(sent(done).body).toEqual({
      ClientId: 'web-client',
      Username: 'owner@example.com',
      ConfirmationCode: '123456',
      Password: 'newpass1234',
    });
    const wrong = cognito(400, { __type: 'CodeMismatchException' });
    expect(await finishPasswordReset(cfg, 'o', '1', 'p', wrong)).toEqual({ kind: 'wrong' });
  });
});
