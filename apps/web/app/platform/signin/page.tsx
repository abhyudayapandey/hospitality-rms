const REASONS: Record<string, string> = {
  idle: 'Your platform session ended after 30 minutes without activity.',
  absolute: 'Platform sessions last at most 8 hours. Sign in again.',
  invalid: 'Sign in to the platform console.',
  cognito: 'Platform sign-in failed or is not configured.',
  not_platform_admin: 'That account is not a platform admin.',
  rate_limited: 'Too many sign-in attempts from here. Wait a few minutes and try again.',
};

// Platform admins sign in through their own pool, with an authenticator app (ADR 012).
export default async function PlatformSignIn({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Platform console</h1>
      {reason && (
        <p role="status" className="rounded-lg bg-slate-100 p-3 text-sm">
          {REASONS[reason] ?? REASONS.invalid}
        </p>
      )}
      <a
        href="/platform/auth/login"
        className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
      >
        Sign in
      </a>
      <p className="text-sm text-slate-600">
        For platform admins only. You need your password and your authenticator app.
      </p>
    </div>
  );
}
