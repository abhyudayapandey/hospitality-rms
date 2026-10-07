import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { customerStatus, jobLabel, jobStatus, type PlatformCustomer } from '../../parts';
import { StatusControl } from '../../status-control';
import { Bundles, type CustomerModule } from './bundles';
import { AccountOwners, type Owner } from './owners';

interface Job {
  id: string;
  kind: string;
  status: string;
  created_at: Date;
}

// One customer (metadata only, ADR 012): add an outlet, their people's sign-ins, update from
// their files; what they buy (ADR 067); account owners; history; pausing last (ADR 075).
export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const { customer, jobs, owners, modules } = await withPlatformAdmin(admin, async (tx) => ({
    customer: (
      await sql<PlatformCustomer>`select * from platform.customer(${id}::uuid)`.execute(tx)
    ).rows[0],
    owners: (
      await sql<Owner>`select * from platform.account_owners(${id}::uuid)`.execute(tx)
    ).rows.map((o) => ({
      ...o,
      created_at: new Date(o.created_at).toISOString(),
      last_sign_in_at: o.last_sign_in_at ? new Date(o.last_sign_in_at).toISOString() : null,
    })),
    modules: (
      await sql<CustomerModule>`select * from platform.customer_modules(${id}::uuid)`.execute(tx)
    ).rows,
    jobs: (
      await sql<Job>`
        select id, kind, status, created_at from platform.jobs(200)
         where tenant_id = ${id}::uuid limit 20`.execute(tx)
    ).rows,
  }));
  if (!customer) notFound();
  const link =
    'flex min-h-12 items-center justify-center rounded-lg bg-brand-700 px-3 font-medium text-white';
  const second =
    'flex min-h-12 items-center justify-center rounded-lg px-3 font-medium ring-1 ring-slate-300';
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">{customer.name}</h1>
      <p className="text-sm text-slate-600" data-testid="customer-line">
        {customerStatus(customer.status)} · {customer.is_test ? 'demo customer · ' : ''}
        {customer.user_count} {customer.user_count === 1 ? 'person' : 'people'}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Link href={`/platform/customers/${id}/add-outlet`} className={link}>
          Add an outlet
        </Link>
        <Link href={`/platform/customers/${id}/logins`} className={second}>
          Sign-ins for their people
        </Link>
        <Link href={`/platform/customers/${id}/import`} className={second}>
          Update from their files
        </Link>
      </div>
      <Bundles tenantId={id} customer={customer.name} modules={modules} />
      <AccountOwners tenantId={id} owners={owners} />
      {jobs.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">History</h2>
          <ul className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/platform/jobs/${j.id}`} className="flex justify-between gap-2 p-3">
                  <span>{jobLabel(j.kind)}</span>
                  <span className="shrink-0 text-right text-slate-600">
                    {jobStatus(j.status)} · {formatWhen(j.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* keyed by the state, so it starts closed again once paused or resumed */}
      <details
        key={customer.status}
        className="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200"
      >
        <summary className="min-h-11 cursor-pointer content-center font-medium">
          {customer.status === 'active' ? 'Pause this customer' : 'Resume this customer'}
        </summary>
        <p className="py-2 text-slate-600">
          {customer.status === 'active'
            ? `While paused, nobody at ${customer.name} can sign in and anyone signed in is signed out. Nothing is deleted; you can resume them any time.`
            : `${customer.name} is paused: nobody there can sign in. Resuming lets them sign in again.`}
        </p>
        <StatusControl tenantId={id} status={customer.status} name={customer.name} />
      </details>
    </>
  );
}
