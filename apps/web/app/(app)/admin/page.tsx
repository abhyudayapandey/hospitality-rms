import { errorCodeOf, messageFor } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

// Read-only for the pilot (ADR 004): edits go through ROLE_CHANGE once hr.worker exists.
export default async function AdminPage() {
  const user = await requireUser();
  let data;
  try {
    data = await withUser(user.id, async (tx) => {
      const a = await sql<{
        user_name: string;
        group_code: string;
        node_type: string;
        node_name: string;
        include_descendants: boolean;
      }>`select * from core.admin_role_assignments()`.execute(tx);
      const p = await sql<{ domain_code: string; group_code: string; access: string }>`
        select * from core.admin_domain_policies()`.execute(tx);
      return { assignments: a.rows, policies: p.rows };
    });
  } catch (err) {
    return (
      <p role="alert" className="text-slate-700">
        {messageFor(errorCodeOf(err))}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Roles and access</h1>
      <p className="text-sm text-slate-600">Read-only. Changes go through a role change request.</p>
      <section>
        <h2 className="mb-2 font-semibold">Role assignments</h2>
        <ul
          className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="assignments"
        >
          {data.assignments.map((a, i) => (
            <li key={i} className="p-3 text-sm">
              <span className="font-medium">{a.user_name}</span> · {a.group_code} at {a.node_name} (
              {a.node_type}){a.include_descendants ? '' : ', this node only'}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Domain policies</h2>
        <ul className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
          {data.policies.map((p, i) => (
            <li key={i} className="flex justify-between p-3 text-sm">
              <span>
                {p.group_code} → {p.domain_code}
              </span>
              <span className="font-medium">{p.access}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
