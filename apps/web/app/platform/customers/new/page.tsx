import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { NewCustomerForm } from './new-customer-form';

// ADM-2: company details and the first account owner (invited by email).
export default async function NewCustomerPage() {
  await requirePlatformAdmin();
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">New customer</h1>
        <Link href="/platform" className="text-sm text-slate-600">
          Customers
        </Link>
      </div>
      <NewCustomerForm />
    </>
  );
}
