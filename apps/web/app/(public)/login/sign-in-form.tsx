'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { SignInState } from '@/lib/auth/sign-in-words';
import { PasswordInput, noSpaces } from '@/components/password-input';
import { signIn } from './actions';

// The sign-in form (ADR 161): one screen that walks through Cognito's steps. Each button
// posts its intent; nothing is filled in for the person except the login they typed.

const field =
  'min-h-12 w-full rounded-xl bg-white px-3 text-base ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-700';
const primary =
  'flex min-h-14 w-full items-center justify-center rounded-xl bg-brand-700 text-lg font-semibold text-white shadow-sm disabled:opacity-60';
const quiet = 'min-h-11 text-sm font-medium text-brand-700 underline underline-offset-4';

function Go({ intent, children }: { intent: string; children: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name="intent" value={intent} className={primary} disabled={pending}>
      {pending ? 'One moment…' : children}
    </button>
  );
}

function Quiet({ intent, children }: { intent: string; children: string }) {
  return (
    <button type="submit" name="intent" value={intent} formNoValidate className={quiet}>
      {children}
    </button>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
      {children}
    </label>
  );
}

export function SignInForm({ initial }: { initial: SignInState }) {
  const [state, action] = useActionState(signIn, initial);
  const login = state.login ?? '';
  return (
    <form action={action} className="space-y-4" aria-label="Sign in" data-testid="sign-in-form">
      {'notice' in state && state.notice && (
        <p role="status" className="rounded-xl bg-brand-50 p-3 text-sm text-brand-800">
          {state.notice}
        </p>
      )}
      {state.error && (
        <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {state.error}
        </p>
      )}

      {(state.step === 'password' || state.step === 'forgot') && (
        <div className="space-y-1">
          <Label htmlFor="login">Login ID or email</Label>
          <input
            id="login"
            name="login"
            defaultValue={login}
            autoComplete="username"
            onInput={noSpaces}
            autoCapitalize="none"
            spellCheck={false}
            required
            className={field}
          />
        </div>
      )}
      {state.step !== 'password' && state.step !== 'forgot' && (
        <input type="hidden" name="login" value={login} />
      )}
      {'session' in state && <input type="hidden" name="session" value={state.session} />}

      {state.step === 'password' && (
        <>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              className={field}
            />
          </div>
          <Go intent="password">Sign in</Go>
          <div className="flex flex-wrap justify-between gap-2">
            <Quiet intent="send_code">Email me a code</Quiet>
            <Quiet intent="forgot">Forgot password?</Quiet>
          </div>
        </>
      )}

      {state.step === 'code' && (
        <>
          <p className="text-slate-700">
            We sent a code to {state.to ?? 'your email'}. It works for a few minutes.
          </p>
          <div className="space-y-1">
            <Label htmlFor="code">Code from the email</Label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={`${field} text-center text-2xl tracking-[0.4em]`}
            />
          </div>
          <Go intent="code">Sign in</Go>
          <div className="flex flex-wrap justify-between gap-2">
            <Quiet intent="send_code">Send a new code</Quiet>
            <Quiet intent="back">← Back</Quiet>
          </div>
        </>
      )}

      {(state.step === 'new_password' || state.step === 'reset') && (
        <>
          {state.step === 'new_password' ? (
            <p className="text-slate-700">Welcome, {login}. Choose your own password.</p>
          ) : (
            <>
              <p className="text-slate-700">
                We sent a code to {state.to ?? 'your email'}. Type it, then your new password.
              </p>
              <div className="space-y-1">
                <Label htmlFor="code">Code from the email</Label>
                <input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className={`${field} text-center text-2xl tracking-[0.4em]`}
                />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="new-password">New password</Label>
            <PasswordInput
              id="new-password"
              name="password"
              autoComplete="new-password"
              className={field}
            />
            <p className="text-xs text-slate-500">At least 10 characters, with a number.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="confirm">Type it again</Label>
            <PasswordInput
              id="confirm"
              name="confirm"
              autoComplete="new-password"
              className={field}
            />
          </div>
          <Go intent={state.step}>
            {state.step === 'new_password' ? 'Save and sign in' : 'Change password'}
          </Go>
          <Quiet intent="back">← Back</Quiet>
        </>
      )}

      {state.step === 'forgot' && (
        <>
          <p className="text-sm text-slate-600">
            We email a code to the address on your login. No email? Ask your manager.
          </p>
          <Go intent="send_reset">Email me a reset code</Go>
          <Quiet intent="back">← Back</Quiet>
        </>
      )}
    </form>
  );
}
