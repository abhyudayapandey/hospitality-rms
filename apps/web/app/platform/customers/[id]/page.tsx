import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { jobLabel, type PlatformCustomer } from '../../parts';
import { AccountOwners, type Owner } from './owners';

interface Job {
  id: string;
  kind: string;
  status: string;
  created_at: Date;
}

// One customer (metadata only, ADR 012): import its setup files, create its logins.
export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const { customer, jobs, owners } = await withPlatformAdmin(admin, async (tx) => ({
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
    jobs: (
      await sql<Job>`
        select id, kind, status, created_at from platform.jobs(200)
         where tenant_id = ${id}::uuid limit 20`.execute(tx)
    ).rows,
  }));
  if (!customer) notFound();
  const link =
    'flex min-h-12 items-center justify-center rounded-lg bg-brand-700 px-3 font-medium text-white';
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">
        {customer.name} <span className="text-base text-slate-500">{customer.code}</span>
      </h1>
      <p className="text-sm text-slate-600">
        {customer.status} · {customer.is_test ? 'test customer · ' : ''}
        {customer.user_count} active people
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Link href={`/platform/customers/${id}/import`} className={link}>
          Import setup files
        </Link>
        <Link href={`/platform/customers/${id}/logins`} className={link}>
          Logins
        </Link>
        <Link href={`/platform/customers/${id}/add-outlet`} className={link}>
          Add an outlet
        </Link>
      </div>
      <AccountOwners tenantId={id} owners={owners} />
      {jobs.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Jobs</h2>
          <ul className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/platform/jobs/${j.id}`} className="flex justify-between gap-2 p-3">
                  <span>{jobLabel(j.kind)}</span>
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
