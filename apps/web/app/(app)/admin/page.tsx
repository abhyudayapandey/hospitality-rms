import Link from 'next/link';
import { FilterList } from '@/components/filter-list';
import { groupLabel } from '@/lib/labels';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { formatWhen } from '@/lib/format';

interface AuditRow {
  occurred_at: Date;
  actor: string;
  action: string;
  person: string | null;
  access_group: string | null;
  place: string | null;
  note: string | null;
}

interface Assignment {
  user_name: string;
  group_code: string;
  node_type: string;
  node_name: string;
  include_descendants: boolean;
}

/** Runs a read the user may not be allowed; null when refused. */
async function maybe<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  try {
    return await withUser(userId, fn);
  } catch {
    return null;
  }
}

// Administration hub (ADR 011): people and the access audit for user administrators, and
// the read-only security roles view (ADR 004) for those who hold it. Each section shows
// only what the database lets this user read.
export default async function AdminPage() {
  const user = await requireUser();
  const sole = await maybe(user.id, async (tx) => {
    const r = await sql<{ s: boolean }>`select core.is_sole_account_owner() as s`.execute(tx);
    return r.rows[0]?.s === true;
  });
  const people = await maybe(user.id, async (tx) => {
    const r = await sql<{ n: number }>`select count(*)::int as n from core.admin_users()`.execute(
      tx,
    );
    return r.rows[0]!.n;
  });
  const audit = await maybe(
    user.id,
    async (tx) =>
      (
        await sql<AuditRow>`select occurred_at, actor, action, person, access_group, place, note
                              from core.access_audit(30)`.execute(tx)
      ).rows,
  );
  const roles = await maybe(user.id, async (tx) => {
    const a = await sql<Assignment>`select * from core.admin_role_assignments()`.execute(tx);
    const p = await sql<{ domain_code: string; group_code: string; access: string }>`
      select * from core.admin_domain_policies()`.execute(tx);
    return { assignments: a.rows, policies: p.rows };
  });

  if (people === null && roles === null) {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Administration</h1>
      {sole && (
        <p
          role="note"
          data-testid="sole-owner"
          className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200"
        >
          You are the only account owner. Sensitive access you grant applies at once, and your own
          requests that nobody else could approve are approved automatically (top of chain). Adding
          a second account owner turns approvals on.
        </p>
      )}
      {people !== null && (
        <nav className="grid grid-cols-2 gap-2" aria-label="Administration">
          <Link
            href="/admin/users"
            className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
          >
            People ({people})
          </Link>
          <Link
            href="/admin/audit"
            className="flex min-h-12 items-center justify-center rounded-lg font-medium ring-1 ring-slate-300"
          >
            Access audit
          </Link>
          <Link
            href="/admin/groups"
            className="flex min-h-12 items-center justify-center rounded-lg font-medium ring-1 ring-slate-300"
          >
            Access groups
          </Link>
          <Link
            href="/admin/modules"
            className="flex min-h-12 items-center justify-center rounded-lg font-medium ring-1 ring-slate-300"
          >
            Modules
          </Link>
          <Link
            href="/admin/settings"
            className="flex min-h-12 items-center justify-center rounded-lg font-medium ring-1 ring-slate-300"
          >
            Targets and settings
          </Link>
        </nav>
      )}
      {audit && audit.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Recent access events</h2>
          <FilterList
            testid="access-audit"
            limit={10}
            searchFrom={10}
            noun="access events"
            listClass="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
            rows={audit.map((e, i) => ({
              key: String(i),
              text: [e.action, e.person, e.access_group, e.place, e.actor, e.note].join(' '),
              node: (
                <div className="p-3 text-sm">
                  <span className="font-medium">{e.action}</span>
                  {e.person ? ` · ${e.person}` : ''}
                  {e.access_group ? ` · ${groupLabel(e.access_group)}` : ''}
                  {e.place ? ` at ${e.place}` : ''}
                  <span className="block text-xs text-slate-500">
                    {e.actor} · {formatWhen(e.occurred_at)}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                </div>
              ),
            }))}
          />
          <Link href="/admin/audit" className="mt-2 block text-sm font-medium text-brand-700">
            Open the full audit
          </Link>
        </section>
      )}
      {roles && (
        <>
          <details data-testid="role-details">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">
              Role assignments and domain policies
            </summary>
            <div className="space-y-4 pt-2">
              <section>
                <h2 className="mb-2 font-semibold">Role assignments</h2>
                <p className="mb-2 text-sm text-slate-600">
                  Read-only. Change someone&apos;s access from People.
                </p>
                <FilterList
                  testid="assignments"
                  limit={10}
                  searchFrom={10}
                  noun="assignments"
                  listClass="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
                  rows={roles.assignments.map((a, i) => ({
                    key: String(i),
                    text: `${a.user_name} ${a.group_code} ${a.node_name}`,
                    node: (
                      <div className="p-3 text-sm">
                        <span className="font-medium">{a.user_name}</span> ·{' '}
                        {groupLabel(a.group_code)} at {a.node_name} ({a.node_type})
                        {a.include_descendants ? '' : ', this node only'}
                      </div>
                    ),
                  }))}
                />
              </section>
              <section>
                <h2 className="mb-2 font-semibold">Domain policies</h2>
                <FilterList
                  limit={10}
                  searchFrom={10}
                  noun="policies"
                  listClass="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
                  rows={roles.policies.map((p, i) => ({
                    key: String(i),
                    text: `${p.group_code} ${p.domain_code} ${p.access}`,
                    node: (
                      <div className="flex justify-between p-3 text-sm">
                        <span>
                          {groupLabel(p.group_code)} → {p.domain_code}
                        </span>
                        <span className="font-medium">{p.access}</span>
                      </div>
                    ),
                  }))}
                />
              </section>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
