import Link from 'next/link';
import { own } from '@/lib/own';
import { messageFor } from '@outlet-ops/domain';
import { cognitoConfig } from '@/lib/auth/cognito';
import { signInWords } from '@/lib/auth/sign-in-words';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { SignInForm } from './sign-in-form';

const REASONS: Record<string, string> = {
  expired: messageFor('SESSION_EXPIRED'),
  unknown_user: signInWords.unknownUser,
  rate_limited: signInWords.tooMany,
  cognito: signInWords.failed,
  signed_out_everywhere: 'You are signed out on all your devices. Sign in again to carry on here.',
};

/**
 * The landing and sign-in screen (ADR 056, 161): Senior, what Hey Senior is, and the
 * sign-in form right here, on our own page. Cognito checks the password or code behind it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const cognito = cognitoConfig() !== null;
  const why = reason ? own(REASONS, reason) : undefined;
  return (
    <div className="flex min-h-[calc(100dvh-2rem)] flex-col gap-6 py-4">
      <header className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 36 px mark */}
        <img src="/icon.svg" alt="" width={36} height={36} className="size-9" />
        <span className="text-xl font-bold tracking-tight">Hey Senior</span>
      </header>

      <section className="flex items-end gap-3">
        <div className="flex-1 space-y-2 pb-4">
          <h1 className="text-3xl leading-tight font-bold tracking-tight">
            People come and go. <span className="text-brand-700">Senior stays.</span>
          </h1>
          <p className="text-slate-600">
            Your outlet&apos;s recipes, stock, rosters and daily jobs, on every phone.
          </p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- Senior, a fixed drawing */}
        <img
          src="/senior.svg"
          alt="Senior: a smiling man with grey hair, round glasses and a pencil behind his ear"
          width={120}
          height={150}
          className="h-[150px] w-[120px] shrink-0"
          data-testid="senior"
        />
      </section>

      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        {cognito ? (
          <SignInForm initial={{ step: 'password', ...(why ? { error: why } : {}) }} />
        ) : (
          <div className="space-y-3">
            {why && (
              <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                {why}
              </p>
            )}
            <p className="text-center text-sm text-slate-600">{signInWords.notSetUp}</p>
          </div>
        )}
        {isDevAuthEnabled() && (
          <Link
            href="/dev-login"
            className="mt-3 flex min-h-12 items-center justify-center rounded-xl border border-dashed border-slate-400 text-slate-700"
          >
            Dev login (pick a seeded user)
          </Link>
        )}
      </div>

      <p className="mt-auto text-center text-sm text-slate-500">
        Use the login ID or email your manager gave you. Trouble signing in? Ask your manager.
      </p>
    </div>
  );
}
