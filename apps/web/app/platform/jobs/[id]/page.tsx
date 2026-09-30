import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ImportReport, InviteProgress } from '@outlet-ops/onboarding/upload';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { jobLabel } from '../../parts';
import { ImportReportView } from './import-report';
import { ApplyImport, InviteOwner, JobPoller } from './job-parts';

interface Job {
  id: string;
  kind: 'create_customer' | 'import_dry_run' | 'import_apply' | 'invite_logins';
  status: 'queued' | 'running' | 'done' | 'failed';
  tenant_id: string | null;
  customer_code: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  run_after: Date | null;
  dry_run: string | null;
}

// A platform job, refreshed every 2 s until the worker has finished it.
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const job = await withPlatformAdmin(
    admin,
    async (tx) => (await sql<Job>`select * from platform.job(${id}::uuid)`.execute(tx)).rows[0],
  );
  if (!job) notFound();
  const waiting = job.status === 'queued' && job.run_after && job.run_after > new Date();
  const busy = (job.status === 'queued' || job.status === 'running') && !waiting;
  const isImport = job.kind === 'import_dry_run' || job.kind === 'import_apply';
  const report = isImport ? (job.result as unknown as ImportReport | null) : null;
  return (
    <>
      <Link
        href={job.tenant_id ? `/platform/customers/${job.tenant_id}` : '/platform'}
        className="text-sm text-slate-600"
      >
        ← {job.tenant_id ? job.customer_code : 'Customers'}
      </Link>
      <h1 className="text-xl font-semibold">
        {jobLabel(job.kind)} · {job.customer_code}
      </h1>
      <p data-testid="job-status" className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
        {job.status}
      </p>
      {busy && <JobPoller />}
      {job.error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
          {job.error}
        </p>
      )}
      {job.kind === 'create_customer' && job.status === 'done' && job.result && (
        <InviteOwner
          jobId={job.id}
          email={String(job.result.owner_email)}
          username={String(job.result.owner_username)}
        />
      )}
      {report && <ImportReportView report={report} />}
      {job.kind === 'import_dry_run' && job.status === 'done' && report?.ok && (
        <ApplyImport dryRunJobId={job.id} />
      )}
      {job.kind === 'import_apply' && job.dry_run && (
        <Link href={`/platform/jobs/${job.dry_run}`} className="block text-sm underline">
          The dry run this applied
        </Link>
      )}
      {job.kind === 'invite_logins' && job.result && (
        <p className="text-sm" data-testid="invite-progress">
          {(job.result as unknown as InviteProgress).sent} sent in the last batch,{' '}
          {(job.result as unknown as InviteProgress).waiting} waiting
          {waiting && job.run_after
            ? `; the next batch goes after ${formatWhen(job.run_after)}`
            : ''}
          .
        </p>
      )}
    </>
  );
}
