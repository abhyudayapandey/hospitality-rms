'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import {
  createPerson,
  previewPerson,
  suggestUsername,
  type Created,
  type NewPerson,
  type PreviewRow,
} from '../../actions';
import { AppliesBadge, OneTimePassword } from '../parts';

export function NewPersonForm({
  jobRoles,
  places,
}: {
  jobRoles: { code: string; name: string }[];
  places: { id: string; name: string }[];
}) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [p, setP] = useState<NewPerson>({
    displayName: '',
    username: '',
    loginType: 'username',
    email: '',
    jobRole: jobRoles[0]?.code ?? '',
    homeNode: places[0]?.id ?? '',
  });
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<NewPerson>) => {
    setP({ ...p, ...patch });
    setPreview(null); // any change needs a fresh preview
  };

  if (created) {
    return (
      <div className="space-y-3" data-testid="created">
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {p.displayName} was added as <strong>{created.username}</strong>.
          {created.pending > 0 &&
            ` ${created.pending} sensitive access grant(s) are waiting for approval.`}
        </p>
        {created.temporaryPassword && (
          <OneTimePassword username={created.username} password={created.temporaryPassword} />
        )}
        {!created.temporaryPassword && (
          <p className="text-sm text-slate-600">They sign in with a code sent to their email.</p>
        )}
        <Link href={`/admin/users/${created.userId}`} className="block text-sm underline">
          Open {p.displayName}
        </Link>
      </div>
    );
  }

  return (
    <form
      aria-label="Add a person"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          if (!preview) {
            const r = await previewPerson(p);
            if (r.ok) setPreview(r.data);
            else setError(r.message);
            return;
          }
          const r = await createPerson(p);
          if (r.ok) setCreated(r.data);
          else setError(r.message);
        });
      }}
    >
      <label className="block text-sm font-medium">
        Name
        <input
          required
          value={p.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
          onBlur={() => {
            if (p.displayName && !p.username) {
              void suggestUsername(p.displayName).then((r) => {
                if (r.ok) setP((cur) => (cur.username ? cur : { ...cur, username: r.data }));
              });
            }
          }}
          className={inputClass}
        />
      </label>
      <label className="block text-sm font-medium">
        Username
        <input
          required
          value={p.username}
          onChange={(e) => set({ username: e.target.value.toLowerCase() })}
          pattern="[a-z0-9][a-z0-9._\-]*"
          className={inputClass}
        />
      </label>
      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium">Signs in with</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="radio"
            name="login"
            checked={p.loginType === 'username'}
            onChange={() => set({ loginType: 'username' })}
          />
          Username and password (a temporary password you hand over)
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="radio"
            name="login"
            checked={p.loginType === 'email'}
            onChange={() => set({ loginType: 'email' })}
          />
          Email code
        </label>
      </fieldset>
      {p.loginType === 'email' && (
        <label className="block text-sm font-medium">
          Email
          <input
            type="email"
            required
            value={p.email}
            onChange={(e) => set({ email: e.target.value })}
            className={inputClass}
          />
        </label>
      )}
      <label className="block text-sm font-medium">
        Job role
        <select
          value={p.jobRole}
          onChange={(e) => set({ jobRole: e.target.value })}
          className={inputClass}
        >
          {jobRoles.map((j) => (
            <option key={j.code} value={j.code}>
              {j.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Home place
        <select
          value={p.homeNode}
          onChange={(e) => set({ homeNode: e.target.value })}
          className={inputClass}
        >
          {places.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </label>

      {preview && (
        <section aria-label="Access they will get" className="space-y-2">
          <h2 className="font-semibold">Access they will get</h2>
          <ul
            className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="preview"
          >
            {preview.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-2 p-3 text-sm">
                <span>
                  <span className="font-medium">{r.access_group}</span> at {r.place_name}
                  <span className="block text-xs text-slate-500">{r.covers}</span>
                </span>
                <AppliesBadge applies={r.applies} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {preview ? 'Save' : 'Preview access'}
      </button>
      {preview && (
        <button type="button" className={secondaryButton} onClick={() => setPreview(null)}>
          Change details
        </button>
      )}
    </form>
  );
}
