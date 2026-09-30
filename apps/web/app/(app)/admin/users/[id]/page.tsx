import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import type { AdminUserRow } from '../page';
import { AccessList, AddAccess, EditPerson, LoginActions, type AccessRow } from './person-panel';

// One person (PRD USR-1..3): details, access with dates (extra and cover access), password
// reset and deactivation. core.admin_user refuses anyone outside the admin's scope.
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let data;
  try {
    data = await withUser(user.id, async (tx) => ({
      person: (await sql<AdminUserRow>`select * from core.admin_user(${id}::uuid)`.execute(tx))
        .rows[0],
      access: (await sql<AccessRow>`select * from core.admin_user_access(${id}::uuid)`.execute(tx))
        .rows,
      groups: (
        await sql<{ code: string; name: string; sensitive: boolean }>`
          select * from core.admin_groups()`.execute(tx)
      ).rows,
      places: (
        await sql<{ id: string; name: string; type: string }>`
          select id, name, type from core.admin_places()`.execute(tx)
      ).rows,
      jobRoles: (
        await sql<{ code: string; name: string }>`select * from core.admin_job_roles()`.execute(tx)
      ).rows,
    }));
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to this person.</p>;
  }
  const p = data.person;
  if (!p) return <p className="text-slate-700">You don&apos;t have access to this person.</p>;
  return (
    <div className="space-y-5">
      <Link href="/admin/users" className="text-sm text-slate-600">
        ← People
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
            {p.status}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {p.login_type === 'username' ? `Username ${p.username}` : `Email ${p.email}`} ·{' '}
          {p.job_role_code ?? 'no job role'} · {p.home_node_name}
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
