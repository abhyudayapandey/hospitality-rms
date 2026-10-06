import Link from 'next/link';
import { messageFor } from '@outlet-ops/domain';
import { cognitoConfig } from '@/lib/auth/cognito';
import { isDevAuthEnabled } from '@/lib/dev-auth';

const REASONS: Record<string, string> = {
  expired: messageFor('SESSION_EXPIRED'),
  unknown_user: "That account isn't set up for Outlet Ops yet. Ask your manager.",
  rate_limited: 'Too many sign-in attempts from here. Wait a few minutes and try again.',
  cognito: 'Sign-in failed. Please try again.',
  signed_out_everywhere: 'You are signed out on all your devices. Sign in again to carry on here.',
};

/**
 * The sign-in screen (ADR 056): the app's mark and what it is for, one "Sign in" button
 * (Cognito asks for the phone number or email and the code or password), and who to ask.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const cognito = cognitoConfig() !== null;
  return (
    <div className="flex min-h-[calc(100dvh-2rem)] flex-col">
      <div className="flex flex-1 flex-col justify-center gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 64 px mark */}
          <img
            src="/icon.svg"
            alt=""
            width={64}
            height={64}
            className="size-16 rounded-2xl shadow-sm ring-1 ring-slate-200"
          />
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Outlet Ops</h1>
            <p className="mx-auto max-w-xs text-slate-600">
              Stock, orders, rosters and the day&apos;s jobs for every outlet, in one place.
            </p>
          </div>
        </div>

        {reason && REASONS[reason] && (
          <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            {REASONS[reason]}
          </p>
        )}

        <div className="space-y-3">
          {cognito ? (
            <a
              href="/auth/login"
              className="flex min-h-14 items-center justify-center rounded-xl bg-brand-700 text-lg font-semibold text-white shadow-sm"
            >
              Sign in
            </a>
          ) : (
            <p className="rounded-xl bg-white p-4 text-center text-sm text-slate-600 ring-1 ring-slate-200">
              Sign-in is not set up in this environment.
            </p>
          )}
          {isDevAuthEnabled() && (
            <Link
              href="/dev-login"
              className="flex min-h-12 items-center justify-center rounded-xl border border-dashed border-slate-400 text-slate-700"
            >
              Dev login (pick a seeded user)
            </Link>
          )}
        </div>
      </div>

      <p className="pt-6 pb-2 text-center text-sm text-slate-500">
        Use the phone number or email your manager set up for you. Trouble signing in? Ask your
        manager.
      </p>
    </div>
  );
}
