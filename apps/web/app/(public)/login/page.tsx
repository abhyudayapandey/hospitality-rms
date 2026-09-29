import Link from 'next/link';
import { messageFor } from '@outlet-ops/domain';
import { cognitoConfig } from '@/lib/auth/cognito';
import { isDevAuthEnabled } from '@/lib/dev-auth';

const REASONS: Record<string, string> = {
  expired: messageFor('SESSION_EXPIRED'),
  unknown_user: "That account isn't set up for Outlet Ops yet. Ask your manager.",
  cognito: 'Sign-in failed. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const cognito = cognitoConfig() !== null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Outlet Ops</h1>
        <p className="mt-1 text-slate-600">Sign in to continue.</p>
      </div>
      {reason && REASONS[reason] && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {REASONS[reason]}
        </p>
      )}
      {cognito ? (
        <a
          href="/auth/login"
          className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
        >
          Sign in with your phone
        </a>
      ) : (
        <p className="text-sm text-slate-600">
          Cognito sign-in is not configured in this environment.
        </p>
      )}
      {isDevAuthEnabled() && (
        <Link
          href="/dev-login"
          className="flex min-h-12 items-center justify-center rounded-lg border border-dashed border-slate-400 text-slate-700"
        >
          Dev login (pick a seeded user)
        </Link>
      )}
    </div>
  );
}
