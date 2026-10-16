'use server';

import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { cognitoConfig, CognitoUnavailable } from '@/lib/auth/cognito';
import { signInWords, type SignInState } from '@/lib/auth/sign-in-words';
import {
  answerEmailCode,
  chooseNewPassword,
  finishPasswordReset,
  sendEmailCode,
  signInWithPassword,
  startPasswordReset,
  type SignInStep,
} from '@/lib/auth/sign-in';
import { startSession } from '@/lib/auth/start-session';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';

// Our own sign-in screen (ADR 161). Each form posts here with its intent; the reply is the
// next state of the screen. Passwords and codes pass straight to Cognito and are never
// stored, logged or sent back. Cognito's Session string rides in a hidden field for the
// next step only (valid 3 minutes), as Cognito's own browser libraries keep it.

const value = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v : '';
};
const text = (f: FormData, k: string) => value(f, k).trim();

/** The same screen again, with a message. */
function withError(prev: SignInState, login: string, error: string): SignInState {
  switch (prev.step) {
    case 'password':
    case 'forgot':
      return { step: prev.step, login, error };
    default:
      return { ...prev, login, error };
  }
}

export async function signIn(prev: SignInState, form: FormData): Promise<SignInState> {
  const intent = text(form, 'intent');
  // a login has no spaces (ADR 163)
  const login = text(form, 'login').replace(/\s+/g, '') || prev.login || '';
  if (intent === 'back') return { step: 'password', login };
  if (intent === 'forgot') return { step: 'forgot', login };

  const cfg = cognitoConfig();
  if (!cfg) return { step: 'password', login, error: signInWords.notSetUp };
  const where = clientAddress(await headers());
  if (!(await withinLimit(`signin:${where}`, LIMITS.signIn))) {
    return withError(prev, login, signInWords.tooMany);
  }
  if (!login) return withError(prev, login, signInWords.needLogin);
  const key = login.toLowerCase();
  const sendsEmail = intent === 'send_code' || intent === 'send_reset';
  const limit = sendsEmail ? LIMITS.signInEmail : LIMITS.signInLogin;
  if (!(await withinLimit(`signin-${sendsEmail ? 'mail' : 'login'}:${key}`, limit))) {
    return withError(prev, login, signInWords.tooMany);
  }

  try {
    switch (intent) {
      case 'password': {
        const password = value(form, 'password');
        if (!password) return { step: 'password', login, error: signInWords.needPassword };
        return await settle(cfg, login, await signInWithPassword(cfg, login, password), prev);
      }
      case 'send_code':
        return await settle(cfg, login, await sendEmailCode(cfg, login), prev);
      case 'code': {
        const code = text(form, 'code');
        if (!code) return withError(prev, login, signInWords.needCode);
        return await settle(
          cfg,
          login,
          await answerEmailCode(cfg, login, text(form, 'session'), code),
          prev,
        );
      }
      case 'new_password': {
        const password = value(form, 'password');
        if (password !== value(form, 'confirm')) {
          return withError(prev, login, signInWords.notSame);
        }
        return await settle(
          cfg,
          login,
          await chooseNewPassword(cfg, login, text(form, 'session'), password),
          prev,
        );
      }
      case 'send_reset': {
        const r = await startPasswordReset(cfg, login);
        if (r.kind === 'code_sent') return { step: 'reset', login, to: r.to };
        return await settle(cfg, login, r, { step: 'forgot', login });
      }
      case 'reset': {
        const password = value(form, 'password');
        if (password !== value(form, 'confirm')) {
          return withError(prev, login, signInWords.notSame);
        }
        const r = await finishPasswordReset(cfg, login, text(form, 'code'), password);
        if (r.kind === 'reset_done') {
          return { step: 'password', login, notice: signInWords.resetDone };
        }
        return await settle(cfg, login, r, prev);
      }
      default:
        return { step: 'password', login };
    }
  } catch (err) {
    // signing in ends with redirect('/'), which throws: let it through (and any other Next.js
    // control flow), or a good sign-in reads "Sign-in failed"
    unstable_rethrow(err);
    if (err instanceof CognitoUnavailable) return withError(prev, login, signInWords.noAnswer);
    console.warn(
      JSON.stringify({
        event: 'sign_in_failed',
        intent,
        error: err instanceof Error ? err.message : 'unknown',
      }),
    );
    return withError(prev, login, signInWords.failed);
  }
}

/** Turns Cognito's answer into the next screen; signed in ends with a redirect to Home. */
async function settle(
  cfg: NonNullable<ReturnType<typeof cognitoConfig>>,
  login: string,
  step: SignInStep,
  prev: SignInState,
): Promise<SignInState> {
  switch (step.kind) {
    case 'signed_in': {
      const started = await startSession(cfg, step.tokens);
      if (started === 'unknown_user')
        return { step: 'password', login, error: signInWords.unknownUser };
      redirect('/');
    }
    // eslint-disable-next-line no-fallthrough -- redirect() never returns
    case 'new_password':
      return { step: 'new_password', login, session: step.session };
    case 'email_code':
      return { step: 'code', login, session: step.session, to: step.to };
    case 'wrong':
      if (prev.step === 'password')
        return { step: 'password', login, error: signInWords.wrongPassword };
      if (prev.step === 'code' || prev.step === 'reset')
        return withError(prev, login, signInWords.wrongCode);
      return { step: 'password', login, error: signInWords.expired };
    case 'reset_required':
      return { step: 'forgot', login, error: signInWords.resetRequired };
    case 'no_email':
      return withError(prev, login, signInWords.noEmail);
    case 'weak_password':
      return withError(prev, login, signInWords.weakPassword);
    case 'too_many':
      return withError(prev, login, signInWords.tooMany);
  }
}
