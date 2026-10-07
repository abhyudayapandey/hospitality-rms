import Link from 'next/link';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { jobLabel, type PlatformCustomer as Customer } from './parts';
import { startSetup } from './setup/actions';
import { ThrowAway } from './setup/throw-away';
import { StatusControl } from './status-control';

interface Draft {
  id: string;
  name: string;
  step: string;
  /** set once Check everything has created the company */
  tenant_id: string | null;
  live: boolean;
  created_by_email: string;
  updated_at: Date;
}

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
  const { customers, jobs, drafts } = await withPlatformAdmin(admin, async (tx) => ({
    customers: (await sql<Customer>`select * from platform.customers()`.execute(tx)).rows,
    drafts: (await sql<Draft>`select * from platform.setup_drafts() where not live`.execute(tx))
      .rows,
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
      <form action={startSetup}>
        <button
          type="submit"
          className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Set up a new customer
        </button>
      </form>
      <Link href="/platform/customers/new" className="text-sm text-slate-700 underline">
        New customer: the company and its owner only
      </Link>
      {drafts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Set-ups in progress</h2>
          <ul
            className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200"
            data-testid="setups"
          >
            {drafts.map((d) => (
              <li key={d.id} className="p-3" data-setup={d.name}>
                <Link
                  href={`/platform/setup/${d.id}/${d.step}`}
                  className="flex justify-between gap-2"
                >
                  <span className="font-medium underline">{d.name}</span>
                  <span className="text-right text-slate-600">
                    {d.created_by_email} · {formatWhen(d.updated_at)}
                  </span>
                </Link>
                <ThrowAway id={d.id} name={d.name} created={!!d.tenant_id} compact />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link href="/platform/templates" className="text-sm text-slate-700 underline">
        Outlet templates: what each kind of outlet starts with
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
