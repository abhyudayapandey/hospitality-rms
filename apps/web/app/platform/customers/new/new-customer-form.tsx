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
    ownerLoginType: 'email',
    ownerUsername: '',
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
        <label className="block text-sm font-medium">
          Owner signs in with
          <select
            value={f.ownerLoginType}
            onChange={(e) =>
              setF({ ...f, ownerLoginType: e.target.value as Form['ownerLoginType'] })
            }
            className={inputClass}
          >
            <option value="email">Email (they get an invitation)</option>
            <option value="username">Username and password (no email)</option>
          </select>
        </label>
        <label className="block text-sm font-medium">
          Owner username (optional)
          <input
            value={f.ownerUsername}
            onChange={(e) => setF({ ...f, ownerUsername: e.target.value.toLowerCase() })}
            placeholder={`${(f.code || 'code').toLowerCase()}.owner`}
            pattern="[a-z0-9][a-z0-9._\-]{1,63}"
            title="Lower case: a-z 0-9 . _ -"
            className={inputClass}
          />
        </label>
        {f.ownerLoginType === 'email' &&
          field('Owner email', 'ownerEmail', { required: true, type: 'email' })}
        <p className="text-xs text-slate-500">
          {f.ownerLoginType === 'email'
            ? 'They get an email invitation and sign in with a code sent to that address.'
            : 'No email is sent. Create their login on the customer’s Logins page after the import.'}{' '}
          If you will import the customer’s files, use the owner’s username from their file 07.
        </p>
      </fieldset>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Create customer
      </button>
    </form>
  );
}
