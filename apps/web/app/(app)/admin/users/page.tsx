import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { jobTitles } from '@/lib/job-titles';

export interface AdminUserRow {
  user_id: string;
  display_name: string;
  username: string | null;
  email: string | null;
  login_type: 'username' | 'email';
  status: 'active' | 'inactive';
  job_role_code: string | null;
  home_node_id: string;
  home_node_name: string;
  last_sign_in_at: Date | null;
  admin_rank: number;
}

// People inside the user's administration scope (PRD USR-1). core.admin_users decides who
// is listed; nobody outside the scope is ever sent to the page.
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const q = ((await searchParams).q ?? '').trim().toLowerCase();
  let rows: AdminUserRow[];
  try {
    rows = await withUser(
      user.id,
      async (tx) => (await sql<AdminUserRow>`select * from core.admin_users()`.execute(tx)).rows,
    );
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  const shown = q
    ? rows.filter((r) =>
        [r.display_name, r.username, r.email, title(r.job_role_code), r.home_node_name].some((v) =>
          v?.toLowerCase().includes(q),
        ),
      )
    : rows;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">People</h1>
        <Link href="/admin" className="text-sm text-slate-600">
          Administration
        </Link>
      </div>
      <Link
        href="/admin/users/new"
        className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
      >
        Add a person
      </Link>
      <form role="search" className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Name, username, role or place"
          aria-label="Search people"
          className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
        />
      </form>
      {shown.length === 0 ? (
        <Empty>Nobody matches.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="people"
        >
          {shown.map((r) => (
            <li key={r.user_id}>
              <Link href={`/admin/users/${r.user_id}`} className="block min-h-12 p-3">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{r.display_name}</span>
                  {r.status === 'inactive' && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">inactive</span>
                  )}
                </span>
                <span className="block text-sm text-slate-600">
                  {r.username ?? r.email} ·{' '}
                  {r.job_role_code ? title(r.job_role_code) : 'no job role'} · {r.home_node_name}
                </span>
                <span className="block text-xs text-slate-500">
                  {r.last_sign_in_at
                    ? `Last signed in ${formatWhen(r.last_sign_in_at)}`
                    : 'Never signed in'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
