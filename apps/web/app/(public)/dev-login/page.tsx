import { notFound } from 'next/navigation';
import { DEV_USERS, devUserKey } from '@outlet-ops/db/dev-users';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { devLogin } from './actions';

// DEV ONLY (ADR 004): 404 in production builds.
export default function DevLoginPage() {
  if (!isDevAuthEnabled()) notFound();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Dev login</h1>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Development only. Pick a test user (docs/onboarding/test-data).
      </p>
      <ul className="space-y-2">
        {DEV_USERS.map((u) => (
          <li key={devUserKey(u)}>
            <form action={devLogin}>
              <input type="hidden" name="user" value={devUserKey(u)} />
              <button
                type="submit"
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-xl bg-white px-4 text-left shadow-sm ring-1 ring-slate-200"
              >
                <span className="font-medium">{u.name}</span>
                <span className="text-sm text-slate-600">{u.roles}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
