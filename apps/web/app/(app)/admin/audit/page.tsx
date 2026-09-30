import Link from 'next/link';
import { Empty } from '@/components/messages';
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

// The access audit (PRD USR-4): who granted or removed what, when, and who approved it,
// within the viewer's scope. Access events only, never business data (ADR 009, 010, 011).
export default async function AuditPage() {
  const user = await requireUser();
  let rows: AuditRow[];
  try {
    rows = await withUser(
      user.id,
      async (tx) =>
        (
          await sql<AuditRow>`select occurred_at, actor, action, person, access_group, place, note
                                from core.access_audit(300)`.execute(tx)
        ).rows,
    );
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Access audit</h1>
        <Link href="/admin" className="text-sm text-slate-600">
          Administration
        </Link>
      </div>
      {rows.length === 0 ? (
        <Empty>No access changes yet.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="audit"
        >
          {rows.map((e, i) => (
            <li key={i} className="p-3 text-sm">
              <span className="font-medium">{e.action}</span>
              {e.person ? ` · ${e.person}` : ''}
              {e.access_group ? ` · ${e.access_group}` : ''}
              {e.place ? ` at ${e.place}` : ''}
              <span className="block text-xs text-slate-500">
                by {e.actor} · {formatWhen(e.occurred_at)}
                {e.note ? ` · ${e.note}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
