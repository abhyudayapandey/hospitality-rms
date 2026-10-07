import Link from 'next/link';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { customerStatus, jobLabel, jobStatus, type PlatformCustomer as Customer } from './parts';
import { startSetup } from './setup/actions';
import { ThrowAway } from './setup/throw-away';

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
  tenant_id: string | null;
  created_at: Date;
}

// ADM-4: set up a customer first; then every customer with its state, people and last sign-in
// (pausing one is on its own page, ADR 075); recent activity; the other tools last.
// Customer metadata only: a platform request cannot read customer data (ADR 012).
export default async function PlatformHome() {
  const admin = await requirePlatformAdmin();
  const { customers, jobs, drafts } = await withPlatformAdmin(admin, async (tx) => ({
    customers: (await sql<Customer>`select * from platform.customers()`.execute(tx)).rows,
    drafts: (await sql<Draft>`select * from platform.setup_drafts() where not live`.execute(tx))
      .rows,
    jobs: (
      await sql<Job>`select id, kind, status, tenant_id, created_at from platform.jobs(10)`.execute(
        tx,
      )
    ).rows,
  }));
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const card = 'rounded-xl bg-white ring-1 ring-slate-200';
  const more = 'flex min-h-12 items-center justify-between gap-2 px-3 py-2 text-sm font-medium';
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
      <form action={startSetup} className="space-y-1">
        <button
          type="submit"
          className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Set up a new customer
        </button>
        <p className="text-sm text-slate-600">
          Walks you through their outlets, people and stock, then creates their sign-ins.
        </p>
      </form>
      {drafts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Set-ups in progress</h2>
          <ul className={`divide-y divide-slate-200 text-sm ${card}`} data-testid="setups">
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
      <section className="space-y-2">
        <h2 className="font-semibold">Customers ({customers.length})</h2>
        <ul className={`divide-y divide-slate-200 ${card}`} data-testid="customers">
          {customers.map((c) => (
            <li key={c.id} data-code={c.code}>
              <Link href={`/platform/customers/${c.id}`} className="block space-y-1 p-3">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium underline">{c.name}</span>
                  <span className="flex shrink-0 gap-1 text-xs">
                    {c.is_test && <span className="rounded-full bg-sky-100 px-2 py-0.5">Demo</span>}
                    <span
                      data-testid="customer-status"
                      className={`rounded-full px-2 py-0.5 font-semibold ${
                        c.status === 'active'
                          ? 'bg-emerald-100 text-emerald-900'
                          : 'bg-rose-100 text-rose-900'
                      }`}
                    >
                      {customerStatus(c.status)}
                    </span>
                  </span>
                </span>
                <span className="block text-sm text-slate-600">
                  {c.user_count} {c.user_count === 1 ? 'person' : 'people'} ·{' '}
                  {c.last_activity
                    ? `last sign-in ${formatWhen(c.last_activity)}`
                    : 'nobody has signed in yet'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {jobs.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Recent activity</h2>
          <ul className={`divide-y divide-slate-200 text-sm ${card}`} data-testid="recent">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/platform/jobs/${j.id}`} className="flex justify-between gap-2 p-3">
                  <span>
                    {jobLabel(j.kind)}
                    {nameOf.get(j.tenant_id ?? '') && ` · ${nameOf.get(j.tenant_id ?? '')}`}
                  </span>
                  <span className="shrink-0 text-right text-slate-600">
                    {jobStatus(j.status)} · {formatWhen(j.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2" aria-label="Other tools">
        <h2 className="font-semibold">Other tools</h2>
        <ul className={`divide-y divide-slate-200 ${card}`}>
          <li>
            <Link href="/platform/templates" className={more}>
              <span>
                Kinds of outlet
                <span className="block text-xs font-normal text-slate-600">
                  What a hotel, restaurant, bar or café starts with
                </span>
              </span>
              <span aria-hidden>›</span>
            </Link>
          </li>
          <li>
            <Link href="/platform/customers/new" className={more}>
              <span>
                Add a customer from their files
                <span className="block text-xs font-normal text-slate-600">
                  When their files are already filled in: creates the company and its owner, then
                  you upload the files
                </span>
              </span>
              <span aria-hidden>›</span>
            </Link>
          </li>
        </ul>
      </section>
    </>
  );
}
