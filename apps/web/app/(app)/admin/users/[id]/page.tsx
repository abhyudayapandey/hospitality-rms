import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { statusLabel } from '@/lib/labels';
import type { AdminUserRow } from '../page';
import { AccessList, AddAccess, EditPerson, LoginActions, type AccessRow } from './person-panel';
import { jobTitles } from '@/lib/job-titles';

// One person (PRD USR-1..3): details, access with dates (extra and cover access), password
// reset and deactivation. core.admin_user refuses anyone outside the admin's scope.
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  // the page's parts load side by side, each in its own transaction (ADR 160): one after
  // another they took over 2 s (the job roles one alone 1.3 s), and far longer on a busy server
  const titles = withUser(user.id, jobTitles);
  void titles.catch(() => undefined); // awaited below; never unhandled if the page returns early
  let data;
  try {
    const [person, access, groups, places, jobRoles] = await Promise.all([
      withUser(
        user.id,
        async (tx) =>
          (await sql<AdminUserRow>`select * from core.admin_user(${id}::uuid)`.execute(tx)).rows[0],
      ),
      withUser(
        user.id,
        async (tx) =>
          (await sql<AccessRow>`select * from core.admin_user_access(${id}::uuid)`.execute(tx))
            .rows,
      ),
      withUser(
        user.id,
        async (tx) =>
          (
            await sql<{ code: string; name: string; sensitive: boolean }>`
              select * from core.admin_groups()`.execute(tx)
          ).rows,
      ),
      withUser(
        user.id,
        async (tx) =>
          (
            await sql<{ id: string; name: string; type: string; kind: string }>`
              select id, name, type, kind from core.admin_places()`.execute(tx)
          ).rows,
      ),
      withUser(
        user.id,
        async (tx) =>
          (
            await sql<{ code: string; name: string }>`select * from core.admin_job_roles()`.execute(
              tx,
            )
          ).rows,
      ),
    ]);
    data = { person, access, groups, places, jobRoles };
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to this person.</p>;
  }
  const title = await titles;
  const p = data.person;
  if (!p) return <p className="text-slate-700">You don&apos;t have access to this person.</p>;
  return (
    <div className="space-y-5">
      <Link href="/admin/users" className="text-sm text-slate-600">
        ← Back
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{p.display_name}</h1>
          <span
            data-testid="person-status"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              p.status === 'active' ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-200'
            }`}
          >
            {statusLabel(p.status)}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {p.login_type === 'username' ? `Username ${p.username}` : `Email ${p.email}`} ·{' '}
          {p.job_role_code ? title(p.job_role_code) : 'no job role'} · {p.home_node_name}
        </p>
        <p className="text-xs text-slate-500">
          {p.last_sign_in_at
            ? `Last signed in ${formatWhen(p.last_sign_in_at)}`
            : 'Never signed in'}
        </p>
      </div>
      <LoginActions
        userId={p.user_id}
        status={p.status}
        loginType={p.login_type}
        isSelf={p.user_id === user.id}
      />
      <AccessList access={data.access} />
      <AddAccess
        userId={p.user_id}
        groups={data.groups}
        places={data.places}
        disabled={p.user_id === user.id}
      />
      <EditPerson
        userId={p.user_id}
        displayName={p.display_name}
        email={p.email}
        loginType={p.login_type}
        jobRole={p.job_role_code}
        homeNode={p.home_node_id}
        jobRoles={data.jobRoles}
        places={data.places.filter((n) => n.type === 'org')}
      />
    </div>
  );
}
