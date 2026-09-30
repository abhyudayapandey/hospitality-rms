'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { requestCustomer, type NewCustomerForm as Form } from '../../actions';

export function NewCustomerForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Form>({
    code: '',
    name: '',
    country: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    isTest: false,
    ownerName: '',
    ownerEmail: '',
  });
  const field = (label: string, key: keyof Form, props: Record<string, unknown> = {}) => (
    <label className="block text-sm font-medium">
      {label}
      <input
        value={String(f[key])}
        onChange={(e) =>
          setF({ ...f, [key]: key === 'code' ? e.target.value.toUpperCase() : e.target.value })
        }
        className={inputClass}
        {...props}
      />
    </label>
  );
  return (
    <form
      aria-label="New customer"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await requestCustomer(f);
          if (r.ok) router.push(`/platform/jobs/${r.data}`);
          else setError(r.message);
        });
      }}
    >
      {field('Company name', 'name', { required: true })}
      {field('Customer code', 'code', {
        required: true,
        pattern: '[A-Z0-9][A-Z0-9\\-]{1,39}',
        title: 'Capital letters, digits and dashes',
      })}
      <div className="grid grid-cols-2 gap-2">
        {field('Country', 'country', { required: true })}
        {field('Currency', 'currency', { required: true, pattern: '[A-Z]{3}' })}
      </div>
      {field('Time zone', 'timezone', { required: true })}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={f.isTest}
          onChange={(e) => setF({ ...f, isTest: e.target.checked })}
        />
        Test customer (set now, cannot be changed later)
      </label>
      <fieldset className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <legend className="px-1 text-sm font-semibold">First account owner</legend>
        {field('Owner name', 'ownerName', { required: true })}
        {field('Owner email', 'ownerEmail', { required: true, type: 'email' })}
        <p className="text-xs text-slate-500">
          They get an email invitation and set their own password.
        </p>
      </fieldset>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Create customer
      </button>
    </form>
  );
}
