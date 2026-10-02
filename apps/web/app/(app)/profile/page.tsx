import Link from 'next/link';
import { grantPlace, summariseAccess, type Access } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { PasswordForm, SignOutEverywhere } from './parts';

// Your profile (ADR 018): your own details and access, read-only; change your password
// (username logins); sign out of all devices. Name and email changes stay with an admin.

interface Profile {
  display_name: string;
  username: string | null;
  email: string | null;
  login_type: 'username' | 'email';
  job_role: string | null;
  home_place: string | null;
}

interface Grant {
  access_group: string;
  group_name: string;
  place: string | null;
  include_descendants: boolean | null;
  effective_to: string | null;
  domains: { domain: string; access: Access }[];
}

export default async function ProfilePage() {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => ({
    profile: (
      await sql<Profile>`
        select display_name, username, email, login_type, job_role, home_place
          from core.my_profile()`.execute(tx)
    ).rows[0],
    access: (
      await sql<Grant>`select *, effective_to::text as effective_to from core.my_access()`.execute(
        tx,
      )
    ).rows,
    locations: Number(
      (await sql<{ n: string }>`select count(*) n from hr.location_places()`.execute(tx)).rows[0]
        ?.n ?? 0,
    ),
  }));
  const p = data.profile;
  if (!p) return null;
  const rows: [string, string][] = [
    ['Name', p.display_name],
    ...(p.username ? [['Username', p.username] as [string, string]] : []),
    ...(p.email ? [['Email', p.email] as [string, string]] : []),
    ['Job role', p.job_role ?? 'None'],
    ['Home place', p.home_place ?? 'None'],
    ['Sign-in', p.login_type === 'username' ? 'Username and password' : 'Email code (no password)'],
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Your profile</h1>

      <section aria-labelledby="details" className="space-y-2">
        <h2 id="details" className="font-semibold">
          Details
        </h2>
        <dl
          data-testid="profile-details"
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        >
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-3 text-sm">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium" data-testid={`profile-${k.toLowerCase()}`}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-500">
          To change your name or email, ask your manager or admin.
        </p>
      </section>

      <section aria-labelledby="access" className="space-y-2">
        <h2 id="access" className="font-semibold">
          Your access
        </h2>
        <ul data-testid="profile-access" className="space-y-2">
          {data.access.map((g, i) => {
            const s = summariseAccess(g.domains);
            return (
              <li
                key={i}
                data-testid="access-grant"
                data-group={g.access_group}
                className="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200"
              >
                <p className="font-medium">{grantPlace(g.place, g.include_descendants)}</p>
                <p className="text-xs text-slate-500">
                  {g.group_name}
                  {g.effective_to ? ` · until ${g.effective_to}` : ''}
                </p>
                {s.change.length > 0 && (
                  <p className="mt-2">
                    <span className="font-medium">Change: </span>
                    {s.change.join(', ')}
                  </p>
                )}
                {s.see.length > 0 && (
                  <p className="mt-1">
                    <span className="font-medium">See: </span>
                    {s.see.join(', ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {data.locations > 0 && (
        <Link
          href="/settings/location"
          className="flex min-h-12 items-center justify-between rounded-xl bg-white px-4 text-sm font-medium ring-1 ring-slate-200"
        >
          Outlet location and clock-in radius <span aria-hidden>›</span>
        </Link>
      )}

      {p.login_type === 'username' && (
        <section aria-labelledby="password" className="space-y-2">
          <h2 id="password" className="font-semibold">
            Change password
          </h2>
          <PasswordForm />
        </section>
      )}

      <section aria-labelledby="devices" className="space-y-2">
        <h2 id="devices" className="font-semibold">
          Devices
        </h2>
        <p className="text-sm text-slate-600">
          Lost a phone, or signed in on a shared one? Sign out everywhere, including here.
        </p>
        <SignOutEverywhere />
      </section>
    </div>
  );
}
