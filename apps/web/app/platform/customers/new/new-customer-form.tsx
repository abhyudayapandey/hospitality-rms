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
  // the check before creating: the owner's username and sign-in type, large (ADR 013)
  const [confirming, setConfirming] = useState(false);
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
  // any change after "Create customer" goes back to the form: the check shows what is sent
  const update = (next: Form) => {
    setF(next);
    setConfirming(false);
  };
  const suggested = `${f.code.toLowerCase()}.owner`;
  const field = (label: string, key: keyof Form, props: Record<string, unknown> = {}) => (
    <label className="block text-sm font-medium">
      {label}
      <input
        value={String(f[key])}
        onChange={(e) =>
          update({ ...f, [key]: key === 'code' ? e.target.value.toUpperCase() : e.target.value })
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
        setError(null);
        setConfirming(true);
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
          onChange={(e) => update({ ...f, isTest: e.target.checked })}
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
              update({ ...f, ownerLoginType: e.target.value as Form['ownerLoginType'] })
            }
            className={inputClass}
          >
            <option value="email">Email (they get an invitation)</option>
            <option value="username">Username and password (no email)</option>
          </select>
        </label>
        <div className="space-y-1">
          <label className="block text-sm font-medium">
            Owner username
            <input
              value={f.ownerUsername}
              onChange={(e) => update({ ...f, ownerUsername: e.target.value.toLowerCase() })}
              required
              pattern="[a-z0-9][a-z0-9._\-]{1,63}"
              title="Lower case: a-z 0-9 . _ -"
              autoComplete="off"
              className={inputClass}
            />
          </label>
          <p className="text-sm font-medium text-amber-900">
            Importing files? Enter the owner’s username from their 07_users.csv.
          </p>
          {f.code && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => update({ ...f, ownerUsername: suggested })}
            >
              Use suggested: {suggested}
            </button>
          )}
        </div>
        {f.ownerLoginType === 'email' &&
          field('Owner email', 'ownerEmail', { required: true, type: 'email' })}
        <p className="text-xs text-slate-500">
          {f.ownerLoginType === 'email'
            ? 'They get an email invitation and sign in with a code sent to that address.'
            : 'No email is sent. Create their login on the customer’s Logins page after the import.'}
        </p>
      </fieldset>
      <ErrorBox message={error} />
      {!confirming ? (
        <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
          Create customer
        </button>
      ) : (
        <div
          role="dialog"
          aria-label="Confirm the first account owner"
          className="space-y-3 rounded-xl bg-amber-50 p-4 ring-2 ring-amber-400"
        >
          <p className="text-sm">
            Create <strong>{f.code}</strong> ({f.isTest ? 'test customer' : 'not a test customer'})
            with this first account owner:
          </p>
          <p className="text-3xl font-bold break-all" data-testid="confirm-owner-username">
            {f.ownerUsername}
          </p>
          <p className="text-xl font-semibold" data-testid="confirm-owner-login">
            {f.ownerLoginType === 'email'
              ? `Email login: invitation to ${f.ownerEmail}`
              : 'Username and password: no email is sent'}
          </p>
          <p className="text-sm">
            If you will import this customer’s files, this must be the owner’s username in their
            07_users.csv.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hydrated || pending}
              className={primaryButton}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await requestCustomer(f);
                  if (r.ok) router.push(`/platform/jobs/${r.data}`);
                  else {
                    setError(r.message);
                    setConfirming(false);
                  }
                })
              }
            >
              Confirm and create
            </button>
            <button
              type="button"
              className="min-h-11 rounded-lg px-4 underline"
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
