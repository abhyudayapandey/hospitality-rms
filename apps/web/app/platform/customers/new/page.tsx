import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { NewCustomerForm } from './new-customer-form';

// ADM-2: a customer whose files are already filled in: the company and its first account
// owner here, then their files on Update from their files. The usual way is the set-up
// (ADR 064); this is the other tool (ADR 077).
export default async function NewCustomerPage() {
  await requirePlatformAdmin();
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">Add a customer from their files</h1>
      <p className="text-sm text-slate-600">
        For a customer whose set-up files are already filled in. This creates the company and its
        first account owner; then you upload their files. To start from nothing, use{' '}
        <strong>Set up a new customer</strong> instead.
      </p>
      <NewCustomerForm />
    </>
  );
}
