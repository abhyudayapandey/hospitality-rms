import Link from 'next/link';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { jobLabel, type PlatformCustomer as Customer } from './parts';
import { StatusControl } from './status-control';

interface Job {
  id: string;
  kind: string;
  status: string;
  customer_code: string | null;
  created_at: Date;
}

// ADM-4: every customer with status, people and last activity; suspend or reactivate.
// Customer metadata only: a platform request cannot read customer data (ADR 012).
export default async function PlatformHome() {
  const admin = await requirePlatformAdmin();
  const { customers, jobs } = await withPlatformAdmin(admin, async (tx) => ({
    customers: (await sql<Customer>`select * from platform.customers()`.execute(tx)).rows,
    jobs: (
      await sql<Job>`select id, kind, status, customer_code, created_at from platform.jobs(10)`.execute(
        tx,
      )
    ).rows,
  }));
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Customers</h1>
        <form action="/platform/auth/logout" method="post">
          <button type="submit" className="text-sm text-slate-600 underline">
            Sign out
          </button>
        </form>
      </div>
      <Link
        href="/platform/customers/new"
        className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
      >
        New customer
      </Link>
      <ul
        className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="customers"
      >
        {customers.map((c) => (
          <li key={c.id} className="space-y-2 p-3" data-code={c.code}>
            <div className="flex items-baseline justify-between gap-2">
              <Link href={`/platform/customers/${c.id}`}>
                <span className="font-medium underline">{c.name}</span>{' '}
                <span className="text-sm text-slate-500">{c.code}</span>
              </Link>
              <span className="flex gap-1 text-xs">
                {c.is_test && <span className="rounded-full bg-sky-100 px-2 py-0.5">test</span>}
                <span
                  data-testid="customer-status"
                  className={`rounded-full px-2 py-0.5 font-semibold ${
                    c.status === 'active'
                      ? 'bg-emerald-100 text-emerald-900'
                      : 'bg-rose-100 text-rose-900'
                  }`}
                >
                  {c.status}
                </span>
              </span>
            </div>
            <p className="text-sm text-slate-600">
              {c.user_count} active people ·{' '}
              {c.last_activity ? `last sign-in ${formatWhen(c.last_activity)}` : 'no sign-ins yet'}
            </p>
            <StatusControl tenantId={c.id} status={c.status} name={c.name} />
          </li>
        ))}
      </ul>
      {jobs.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Recent jobs</h2>
          <ul className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/platform/jobs/${j.id}`} className="flex justify-between gap-2 p-3">
                  <span>
                    {jobLabel(j.kind)} {j.customer_code}
                  </span>
                  <span>
                    {j.status} · {formatWhen(j.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
