import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { coverRows, type CoverRow } from '@/lib/cover';
import { answerWords } from '@/lib/cover-words';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { CoverForm } from './cover-form';

// One role at one outlet (ADR 065): who does its work now, the three answers, and what saving
// would do, previewed by the database before Save.
export default async function CoverRolePage({
  params,
}: {
  params: Promise<{ outlet: string; role: string }>;
}) {
  const { outlet, role } = await params;
  const user = await requireUser();
  let rows: CoverRow[];
  try {
    rows = /^[0-9a-f-]{36}$/.test(outlet)
      ? await withUser(user.id, (tx) => coverRows(tx, outlet))
      : [];
  } catch {
    rows = [];
  }
  const r = rows.find((x) => x.job_role_code === role);
  const back = `/admin/cover?outlet=${outlet}`;
  if (!r) {
    return (
      <div className="space-y-4">
        <Link href="/admin/cover" className="text-sm text-slate-600">
          ← Who does what
        </Link>
        <p className="text-slate-700">You don&apos;t have access to this role here.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600">
        ← Who does what
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{r.role_name}</h1>
        <p className="text-sm text-slate-600">{r.outlet_name}</p>
      </div>
      <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <p className="text-sm text-slate-600">Now</p>
        <p className="font-medium" data-testid="cover-now">
          {answerWords(r)}
        </p>
        {r.changed_by && r.changed_at && (
          <p className="text-xs text-slate-500">
            Changed by {r.changed_by}, {formatWhen(r.changed_at)}
          </p>
        )}
      </div>
      {r.can_change ? (
        <CoverForm
          outlet={outlet}
          outletName={r.outlet_name}
          role={{
            code: r.job_role_code,
            name: r.role_name,
            people: r.people,
            duties: r.duties,
            dutyNames: r.duty_names,
          }}
          now={{ answer: r.answer, by: r.covered_by_role, byName: r.covered_by_name }}
          others={rows
            .filter((x) => x.job_role_code !== role && x.answer === 'have')
            .sort(
              (a, b) =>
                Number(b.people > 0) - Number(a.people > 0) ||
                a.role_name.localeCompare(b.role_name),
            )
            .map((x) => ({
              code: x.job_role_code,
              name: x.role_name,
              people: x.people,
              duties: x.duties,
            }))}
          back={back}
        />
      ) : (
        <p className="text-sm text-slate-600">You can see this outlet but not change it.</p>
      )}
    </div>
  );
}
