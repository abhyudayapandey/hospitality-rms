import Link from 'next/link';
import { sql, withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { InviteOwner, JobPoller } from './job-parts';

interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  customer_code: string | null;
  result: { owner_username: string; owner_email: string } | null;
  error: string | null;
}

// A platform job, refreshed every 2 s until the worker has finished it.
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requirePlatformAdmin();
  const job = await withPlatformAdmin(admin, async (tx) => {
    const r = await sql<Job>`
      select id, kind, status, customer_code, result, error from platform.jobs(200)
       where id = ${id}::uuid`.execute(tx);
    return r.rows[0];
  });
  if (!job) return <p>Job not found.</p>;
  const busy = job.status === 'queued' || job.status === 'running';
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">Creating {job.customer_code}</h1>
      <p data-testid="job-status" className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
        {job.status}
      </p>
      {busy && <JobPoller />}
      {job.status === 'failed' && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
          {job.error}
        </p>
      )}
      {job.status === 'done' && job.result && (
        <InviteOwner
          jobId={job.id}
          email={job.result.owner_email}
          username={job.result.owner_username}
        />
      )}
    </>
  );
}
