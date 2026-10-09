'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { registerDef } from '@outlet-ops/domain';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { addRegisterEntry } from './actions';

/** A new entry in a register (ADR 090): its fields, the required ones first. */
export function EntryForm({ place, register }: { place: string; register: string }) {
  const def = registerDef(register)!;
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const missing = def.fields.some((f) => f.required && !values[f.key]?.trim());
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await addRegisterEntry({
            place,
            register,
            fields: values,
            idempotencyKey: key,
          });
          if (!r.ok) return setError(r.message);
          setValues({});
          setKey(crypto.randomUUID());
          router.refresh();
        });
      }}
    >
      <h2 className="font-semibold">New entry</h2>
      {def.fields.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-sm font-medium">
            {f.label}
            {!f.required && <span className="font-normal text-slate-500"> (optional)</span>}
          </span>
          {f.options ? (
            <select
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              className={inputClass}
            >
              <option value="">Choose</option>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              maxLength={500}
              className={inputClass}
            />
          )}
        </label>
      ))}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || missing} className={primaryButton}>
        Add to the register
      </button>
    </form>
  );
}
