'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import {
  CARRIABLE_ROLES,
  codeFromName,
  isProductCode,
  RIGHT_OPTIONS,
  rightsPayload,
  type Level,
} from '@/lib/custom-groups';
import { archiveCustomGroup, saveCustomGroup } from '../actions';

export interface GroupFormValue {
  code: string;
  name: string;
  rights: Record<string, 'view' | 'modify'>;
  actsAs: string[];
  holders: number;
}

/**
 * Builds or edits one of the company's groups (ADR 027): a name, the rights (none, see,
 * change), and the product roles whose requests and approvals it carries. Saving an edit
 * changes access at once for everyone holding it, so the form says how many that is.
 */
export function GroupForm({ initial }: { initial: GroupFormValue | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [levels, setLevels] = useState<Record<string, Level>>(initial?.rights ?? {});
  const [actsAs, setActsAs] = useState<string[]>(initial?.actsAs ?? []);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const code = initial?.code ?? codeFromName(name);
  const taken = !initial && isProductCode(code);

  const save = () =>
    start(async () => {
      const r = await saveCustomGroup({ code, name, rights: rightsPayload(levels), actsAs });
      if (!r.ok) setError(r.message);
      else router.push('/admin/groups');
    });
  const remove = () =>
    start(async () => {
      const r = await archiveCustomGroup(code);
      if (!r.ok) setError(r.message);
      else router.push('/admin/groups');
    });

  return (
    <form
      aria-label="Access group"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        <span className="block text-xs text-slate-500" data-testid="group-code">
          {code ? `Code ${code}` : 'Type a name of three letters or more'}
          {taken ? ' is a product group: choose another name' : ''}
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Rights</legend>
        <p className="text-xs text-slate-500">
          A right applies where the group is given: stock rights at a store, people rights at a
          department or outlet.
        </p>
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {RIGHT_OPTIONS.filter((r) => r.where !== 'yourself').map((r) => (
            <li key={r.code} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 text-sm">
                <span className="block first-letter:uppercase">{r.words}</span>
                <span className="text-xs text-slate-500">at {r.where}</span>
              </span>
              <select
                aria-label={r.words}
                value={levels[r.code] ?? 'none'}
                onChange={(e) => setLevels({ ...levels, [r.code]: e.target.value as Level })}
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-sm"
              >
                <option value="none">None</option>
                <option value="view">See</option>
                <option value="modify">Change</option>
              </select>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Requests and approvals like</legend>
        <p className="text-xs text-slate-500">
          People with this group get the requests and approvals of these roles where it is given, as
          if they held them. Nobody approves their own request.
        </p>
        <ul className="grid grid-cols-1 gap-1">
          {CARRIABLE_ROLES.map((r) => (
            <li key={r.code}>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={actsAs.includes(r.code)}
                  onChange={(e) =>
                    setActsAs(
                      e.target.checked ? [...actsAs, r.code] : actsAs.filter((x) => x !== r.code),
                    )
                  }
                />
                {r.name}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {initial && initial.holders > 0 && (
        <p role="note" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Saving changes the access of {initial.holders}{' '}
          {initial.holders === 1 ? 'person' : 'people'} who hold this group, straight away.
        </p>
      )}
      <ErrorBox message={error} />
      <button type="submit" disabled={pending || !code || taken} className={primaryButton}>
        {initial ? 'Save changes' : 'Create group'}
      </button>
      {initial &&
        initial.holders === 0 &&
        (confirmRemove ? (
          <div role="group" aria-label="Remove group" className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setConfirmRemove(false)}
            >
              Keep it
            </button>
            <button type="button" disabled={pending} className={primaryButton} onClick={remove}>
              Remove
            </button>
          </div>
        ) : (
          <button type="button" className={secondaryButton} onClick={() => setConfirmRemove(true)}>
            Remove group
          </button>
        ))}
    </form>
  );
}
