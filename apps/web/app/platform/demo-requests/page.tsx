import Link from 'next/link';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { demoOutlets, type DemoRequestRow } from '../parts';
import { HandledButton } from './handled-button';

// Demo requests from the website (ADR 141): the new ones first, each with a number to tap and
// call; "Called back" takes it off the list. Handled ones stay below, with who and when.
export default async function DemoRequests() {
  const admin = await requirePlatformAdmin();
  const rows = await withPlatformAdmin(
    admin,
    async (tx) =>
      (await sql<DemoRequestRow>`select * from platform.demo_requests()`.execute(tx)).rows,
  );
  const fresh = rows.filter((r) => !r.handled_at);
  const done = rows.filter((r) => r.handled_at);
  const card = 'rounded-xl bg-white ring-1 ring-slate-200';
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600 underline">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">Demo requests</h1>
      <section className="space-y-2">
        <h2 className="font-semibold">New ({fresh.length})</h2>
        {fresh.length === 0 ? (
          <p className={`p-3 text-sm text-slate-600 ${card}`}>Nobody is waiting for a call.</p>
        ) : (
          <ul className={`divide-y divide-slate-200 ${card}`} data-testid="demo-new">
            {fresh.map((r) => (
              <li key={r.id} className="space-y-2 p-3" data-demo={r.business}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{r.business}</span>
                  <span className="shrink-0 text-sm text-slate-600">
                    {formatWhen(r.created_at)}
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  {r.name} · {demoOutlets(r.outlet_kind, r.outlets)}
                </p>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <a
                    href={`tel:${r.phone.replace(/[^+0-9]/g, '')}`}
                    className="font-medium underline"
                  >
                    {r.phone}
                  </a>
                  {r.email && (
                    <a href={`mailto:${r.email}`} className="underline">
                      {r.email}
                    </a>
                  )}
                </p>
                <HandledButton id={r.id} name={r.business} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Called back</h2>
          <ul className={`divide-y divide-slate-200 text-sm ${card}`}>
            {done.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 p-3">
                <span>
                  {r.business} · {r.name} · {r.phone}
                </span>
                <span className="shrink-0 text-right text-slate-600">
                  {r.handled_by_email} · {formatWhen(r.handled_at!)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
