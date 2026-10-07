import Link from 'next/link';
import { byLevel } from '@outlet-ops/domain';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { coverOutlets, coverRows, type CoverRow } from '@/lib/cover';
import { answerWords } from '@/lib/cover-words';
import { withUser } from '@/lib/db';
import { OutletPicker } from './outlet-picker';

// Admin → Who does what (ADR 065, Step 6 of docs/templates-and-cover.md): per outlet, each
// job role that works there and who does its work: "We have it", "Someone else does it:
// [role]" or "We don't do this". "All outlets" lists only the covers in place; an outlet
// lists every role, highest level first. User administration only; view-only admins read.
export default async function CoverPage({
  searchParams,
}: {
  searchParams: Promise<{ outlet?: string }>;
}) {
  const { outlet: asked } = await searchParams;
  const user = await requireUser();
  let data;
  try {
    data = await withUser(user.id, async (tx) => {
      const outlets = await coverOutlets(tx);
      const one = outlets.length === 1 ? outlets[0]!.outlet_id : null;
      const outlet = outlets.find((o) => o.outlet_id === asked)?.outlet_id ?? one;
      return { outlets, outlet, rows: await coverRows(tx, outlet) };
    });
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to who does what.</p>;
  }
  const { outlets, outlet, rows } = data;
  const here = outlets.find((o) => o.outlet_id === outlet);
  return (
    <div className="space-y-4">
      <OutletPicker
        outlets={outlets.map((o) => ({ id: o.outlet_id, name: o.outlet_name }))}
        current={outlet}
      />
      <Link href="/admin" className="text-sm text-slate-600">
        ← Administration
      </Link>
      <h1 className="text-xl font-semibold">Who does what</h1>
      {outlet ? (
        <>
          <p className="text-sm text-slate-600">
            Each role at {here?.outlet_name}: its own people do its work, someone else covers it, or
            it isn&apos;t done here.
            {!here?.can_change && ' You can see this outlet but not change it.'}
          </p>
          <ul className="space-y-2" data-testid="cover-roles">
            {byLevel(rows.map((r) => ({ ...r, name: r.role_name }))).map((r) => (
              <li key={r.job_role_code} data-testid="cover-role" data-role={r.job_role_code}>
                <RoleLine row={r} />
              </li>
            ))}
          </ul>
        </>
      ) : rows.length === 0 ? (
        <Empty>
          At every outlet, each role&apos;s own people do its work. Choose an outlet to change who
          does what.
        </Empty>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Where a role is covered by another or not done. Choose an outlet to see every role.
          </p>
          <ul className="space-y-2" data-testid="cover-roles">
            {rows.map((r) => (
              <li
                key={`${r.outlet_id} ${r.job_role_code}`}
                data-testid="cover-role"
                data-role={r.job_role_code}
              >
                <RoleLine row={r} outlet />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RoleLine({ row: r, outlet = false }: { row: CoverRow; outlet?: boolean }) {
  const body = (
    <>
      <span className="block font-medium">
        {r.role_name}
        {outlet && <span className="font-normal text-slate-500"> · {r.outlet_name}</span>}
      </span>
      <span
        data-testid="cover-answer"
        className={`block text-sm ${
          r.answer === 'have' && r.people > 0
            ? 'text-slate-600'
            : r.answer === 'have'
              ? 'text-amber-800'
              : 'font-medium text-brand-700'
        }`}
      >
        {answerWords(r)}
      </span>
    </>
  );
  const box = 'block min-h-12 rounded-xl bg-white p-3 ring-1 ring-slate-200';
  return r.can_change ? (
    <Link href={`/admin/cover/${r.outlet_id}/${r.job_role_code}`} className={box}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}
