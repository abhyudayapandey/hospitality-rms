import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInWords } from '@/lib/auth/sign-in-words';

// The sign-in screen's action (ADR 161) with Cognito and the session stubbed. A good password
// ends with the redirect to Home: the action must not catch it and show "Sign-in failed"
// (the bug the first live sign-ins hit).

const cognito = {
  step: { kind: 'signed_in', tokens: { idToken: 'id' } } as unknown,
  error: null as Error | null,
};
const session = { result: 'ok' as 'ok' | 'unknown_user' };

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('@/lib/security/rate-limit', () => ({
  LIMITS: { signIn: {}, signInLogin: {}, signInEmail: {} },
  clientAddress: () => 'test',
  withinLimit: () => Promise.resolve(true),
}));
vi.mock('@/lib/auth/start-session', () => ({
  startSession: () => Promise.resolve(session.result),
}));
vi.mock('@/lib/auth/sign-in', () => ({
  signInWithPassword: () =>
    cognito.error ? Promise.reject(cognito.error) : Promise.resolve(cognito.step),
}));
vi.mock('@/lib/auth/cognito', async (real) => ({
  ...(await real<typeof import('@/lib/auth/cognito')>()),
  cognitoConfig: () => ({
    userPoolId: 'ap-south-1_Pool',
    clientId: 'web',
    domain: 'x',
    appUrl: 'https://app.example.com',
  }),
}));

const { signIn } = await import('./actions');
const { CognitoUnavailable } = await import('@/lib/auth/cognito');

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const password = form({ intent: 'password', login: 'test.chef', password: 'right-pass-1' });

describe('signing in with a password', () => {
  beforeEach(() => {
    cognito.step = { kind: 'signed_in', tokens: { idToken: 'id' } };
    cognito.error = null;
    session.result = 'ok';
  });

  it('a good password goes to Home, never "Sign-in failed"', async () => {
    const err = (await signIn({ step: 'password' }, password).then(
      () => null,
      (e: unknown) => e,
    )) as { digest?: string } | null;
    expect(err?.digest).toMatch(/^NEXT_REDIRECT;replace;\/;/);
  });

  it('a login with no person in the app says so', async () => {
    session.result = 'unknown_user';
    expect(await signIn({ step: 'password' }, password)).toEqual({
      step: 'password',
      login: 'test.chef',
      error: signInWords.unknownUser,
    });
  });

  it('a wrong password says so; Cognito not answering says so; anything else fails', async () => {
    cognito.step = { kind: 'wrong' };
    expect(await signIn({ step: 'password' }, password)).toMatchObject({
      error: signInWords.wrongPassword,
    });
    cognito.error = new CognitoUnavailable('timeout');
    expect(await signIn({ step: 'password' }, password)).toMatchObject({
      error: signInWords.noAnswer,
    });
    cognito.error = new Error('COGNITO_InitiateAuth_ResourceNotFoundException');
    expect(await signIn({ step: 'password' }, password)).toMatchObject({
      error: signInWords.failed,
    });
  });
});
