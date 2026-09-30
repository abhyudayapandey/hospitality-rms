import { errorCodeOf, messageFor } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
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
      const sole = await sql<{ s: boolean }>`select core.is_sole_account_owner() as s`.execute(tx);
      return { assignments: a.rows, policies: p.rows, sole: sole.rows[0]?.s === true };
    });
  } catch (err) {
    return (
      <p role="alert" className="text-slate-700">
        {messageFor(errorCodeOf(err))}
      </p>
    );
  }
  // access events (grants, removals, approvals): only for those with USER_ACCESS view
  let audit: AuditRow[];
  try {
    audit = await withUser(
      user.id,
      async (tx) =>
        (
          await sql<AuditRow>`select occurred_at, actor, action, person, access_group, place, note
                              from core.access_audit(30)`.execute(tx)
        ).rows,
    );
  } catch {
    audit = [];
  }
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Roles and access</h1>
      <p className="text-sm text-slate-600">Read-only. Changes go through a role change request.</p>
      {data.sole && (
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
      {audit.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Recent access events</h2>
          <ul
            className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="access-audit"
          >
            {audit.map((e, i) => (
              <li key={i} className="p-3 text-sm">
                <span className="font-medium">{e.action}</span>
                {e.person ? ` · ${e.person}` : ''}
                {e.access_group ? ` · ${e.access_group}` : ''}
                {e.place ? ` at ${e.place}` : ''}
                <span className="block text-xs text-slate-500">
                  {e.actor} · {formatWhen(e.occurred_at)}
                  {e.note ? ` · ${e.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
