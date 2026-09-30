import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isErrorCode, messageFor } from '@outlet-ops/domain';
import { ErrorBox, primaryButton } from '@/components/messages';
import { sql, withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import type { PlatformCustomer } from '../../../parts';

// Import a customer's setup files (ADR 013, PRD ADM-3): one zip or the CSV files. The
// upload runs a dry run first; applying is a separate step on the report.
export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const customer = await withPlatformAdmin(
    admin,
    async (tx) =>
      (await sql<PlatformCustomer>`select * from platform.customer(${id}::uuid)`.execute(tx))
        .rows[0],
  );
  if (!customer) notFound();
  return (
    <>
      <Link href={`/platform/customers/${id}`} className="text-sm text-slate-600">
        ← {customer.name}
      </Link>
      <h1 className="text-xl font-semibold">Import setup files</h1>
      <p className="text-sm text-slate-600">
        The onboarding files for <strong>{customer.code}</strong>: one zip, or the CSV files
        themselves (5 MB at most). Only the numbered files (00_customer.csv to 17_…) are read; file
        00 must name {customer.code}. You get a dry run first; nothing changes until you apply it.
      </p>
      <ErrorBox message={error && isErrorCode(error) ? messageFor(error) : null} />
      <form
        aria-label="Import setup files"
        action={`/platform/customers/${id}/import/upload`}
        method="post"
        encType="multipart/form-data"
        className="space-y-3"
      >
        <label className="block text-sm font-medium">
          Files
          <input
            type="file"
            name="files"
            multiple
            required
            accept=".zip,.csv,application/zip,text/csv"
            className="mt-1 block w-full text-sm"
          />
        </label>
        <button type="submit" className={primaryButton}>
          Upload and dry run
        </button>
      </form>
    </>
  );
}
