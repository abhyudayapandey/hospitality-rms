'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import {
  createLogin,
  deactivatePerson,
  grantAccess,
  previewGrant,
  reactivatePerson,
  resetPassword,
  revokeAccess,
  updatePerson,
} from '../../actions';
import { AppliesBadge, OneTimePassword } from '../parts';

export interface AccessRow {
  assignment_id: string | null;
  role_change_id: string | null;
  access_group: string;
  sensitive: boolean;
  node_id: string;
  node_name: string;
  include_descendants: boolean;
  effective_from: string | Date;
  effective_to: string | Date | null;
  source: string;
  note: string | null;
  state: string;
}

const small =
  'min-h-11 rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50';
const dark =
  'min-h-11 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white disabled:opacity-50';
const day = (d: string | Date | null) =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const act = <T,>(
    fn: () => Promise<{ ok: true; data: T } | { ok: false; message: string }>,
    done: (data: T) => string | null,
  ) =>
    start(async () => {
      setError(null);
      setStatus(null);
      const r = await fn();
      if (!r.ok) return setError(r.message);
      setStatus(done(r.data));
      router.refresh();
    });
  return { pending, error, status, act };
}

export function LoginActions({
  userId,
  status,
  loginType,
  isSelf,
}: {
  userId: string;
  status: 'active' | 'inactive';
  loginType: 'username' | 'email';
  isSelf: boolean;
}) {
  const hydrated = useHydrated();
  const { pending, error, status: done, act } = useAction();
  const [password, setPassword] = useState<{ username: string; password: string } | null>(null);
  if (isSelf) return null;
  return (
    <section aria-label="Login" className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {loginType === 'username' && status === 'active' && (
          <button
            type="button"
            className={small}
            disabled={!hydrated || pending}
            onClick={() =>
              act(
                () => resetPassword(userId),
                (p) => {
                  setPassword({ username: 'this person', password: p });
                  return 'Password reset. Hand the temporary password over in person.';
                },
              )
            }
          >
            Reset password
          </button>
        )}
        {status === 'active' ? (
          <button
            type="button"
            className={small}
            disabled={!hydrated || pending}
            onClick={() =>
              act(
                () => deactivatePerson(userId),
                () => 'Deactivated: signed out everywhere and unable to sign in.',
              )
            }
          >
            Deactivate
          </button>
        ) : (
          <button
            type="button"
            className={small}
            disabled={!hydrated || pending}
            onClick={() =>
              act(
                () => reactivatePerson(userId),
                () => 'Reactivated.',
              )
            }
          >
            Reactivate
          </button>
        )}
        {status === 'active' && (
          <button
            type="button"
            className={small}
            disabled={!hydrated || pending}
            onClick={() =>
              act(
                () => createLogin(userId),
                (r) => {
                  if (r.temporaryPassword) {
                    setPassword({ username: 'this person', password: r.temporaryPassword });
                  }
                  return 'Login set up.';
                },
              )
            }
          >
            Set up login again
          </button>
        )}
      </div>
      <StatusBox message={done} />
      {password && <OneTimePassword username={password.username} password={password.password} />}
      <ErrorBox message={error} />
    </section>
  );
}

export function AccessList({ access }: { access: AccessRow[] }) {
  const hydrated = useHydrated();
  const { pending, error, status, act } = useAction();
  return (
    <section aria-label="Access" className="space-y-2">
      <h2 className="font-semibold">Access</h2>
      <ul
        className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="person-access"
      >
        {access.map((a, i) => (
          <li key={a.assignment_id ?? a.role_change_id ?? i} className="p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span>
                <span className="font-medium">{a.access_group}</span> at {a.node_name}
                <span className="block text-xs text-slate-500">
                  {a.include_descendants ? 'and everything below' : 'this place only'} · from{' '}
                  {day(a.effective_from)}
                  {a.effective_to ? ` to ${day(a.effective_to)}` : ''} · {a.source}
                  {a.note ? ` · ${a.note}` : ''}
                </span>
              </span>
              {a.state === 'waiting for approval' ? (
                <AppliesBadge applies="approval" />
              ) : (
                a.assignment_id && (
                  <button
                    type="button"
                    className={small}
                    disabled={!hydrated || pending}
                    onClick={() =>
                      act(
                        () => revokeAccess(a.assignment_id!),
                        (r) =>
                          r.status === 'pending'
                            ? 'Removal sent for approval (ROLE_CHANGE).'
                            : 'Access ended.',
                      )
                    }
                  >
                    End
                  </button>
                )
              )}
            </div>
          </li>
        ))}
      </ul>
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </section>
  );
}

export function AddAccess({
  userId,
  groups,
  places,
  disabled,
}: {
  userId: string;
  groups: { code: string; name: string }[];
  places: { id: string; name: string }[];
  disabled: boolean;
}) {
  const hydrated = useHydrated();
  const { pending, error, status, act } = useAction();
  const [g, setG] = useState({
    group: groups[0]?.code ?? '',
    node: places[0]?.id ?? '',
    from: '',
    to: '',
    reason: '',
    includeDescendants: true,
  });
  const [applies, setApplies] = useState<string | null>(null);
  const change = (patch: Partial<typeof g>) => {
    const next = { ...g, ...patch };
    setG(next);
    setApplies(null);
    if (next.group && next.node) {
      void previewGrant(userId, next.group, next.node).then((r) =>
        setApplies(r.ok ? r.data : null),
      );
    }
  };
  if (disabled) return null;
  return (
    <form
      aria-label="Add access"
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          () => grantAccess(userId, { ...g, idempotencyKey: crypto.randomUUID() }),
          (r) => (r.status === 'pending' ? 'Sent for approval (ROLE_CHANGE).' : 'Access added.'),
        );
      }}
    >
      <h2 className="font-semibold">Add access or cover</h2>
      <label className="block text-sm font-medium">
        Access
        <select
          value={g.group}
          onChange={(e) => change({ group: e.target.value })}
          className={inputClass}
        >
          {groups.map((x) => (
            <option key={x.code} value={x.code}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Place
        <select
          value={g.node}
          onChange={(e) => change({ node: e.target.value })}
          className={inputClass}
        >
          {places.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium">
          From
          <input
            type="date"
            value={g.from}
            onChange={(e) => setG({ ...g, from: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="block text-sm font-medium">
          To
          <input
            type="date"
            value={g.to}
            onChange={(e) => setG({ ...g, to: e.target.value })}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Reason
        <input
          value={g.reason}
          onChange={(e) => setG({ ...g, reason: e.target.value })}
          maxLength={300}
          className={inputClass}
        />
      </label>
      {applies && <AppliesBadge applies={applies} />}
      <button type="submit" disabled={!hydrated || pending} className={`${dark} w-full`}>
        Add access
      </button>
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </form>
  );
}

export function EditPerson({
  userId,
  displayName,
  email,
  loginType,
  jobRole,
  homeNode,
  jobRoles,
  places,
}: {
  userId: string;
  displayName: string;
  email: string | null;
  loginType: 'username' | 'email';
  jobRole: string | null;
  homeNode: string;
  jobRoles: { code: string; name: string }[];
  places: { id: string; name: string }[];
}) {
  const hydrated = useHydrated();
  const { pending, error, status, act } = useAction();
  const [v, setV] = useState({
    displayName,
    email: email ?? '',
    jobRole: jobRole ?? '',
    homeNode,
  });
  return (
    <form
      aria-label="Edit person"
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          () =>
            updatePerson(userId, {
              displayName: v.displayName !== displayName ? v.displayName : '',
              email: loginType === 'email' && v.email !== (email ?? '') ? v.email : '',
              jobRole: v.jobRole !== (jobRole ?? '') ? v.jobRole : '',
              homeNode: v.homeNode !== homeNode ? v.homeNode : '',
            }),
          (r) =>
            r.pending > 0
              ? `Saved. ${r.pending} sensitive change(s) are waiting for approval.`
              : 'Saved.',
        );
      }}
    >
      <h2 className="font-semibold">Details</h2>
      <label className="block text-sm font-medium">
        Name
        <input
          value={v.displayName}
          onChange={(e) => setV({ ...v, displayName: e.target.value })}
          className={inputClass}
        />
      </label>
      {loginType === 'email' && (
        <label className="block text-sm font-medium">
          Email
          <input
            type="email"
            value={v.email}
            onChange={(e) => setV({ ...v, email: e.target.value })}
            className={inputClass}
          />
        </label>
      )}
      <label className="block text-sm font-medium">
        Job role
        <select
          value={v.jobRole}
          onChange={(e) => setV({ ...v, jobRole: e.target.value })}
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
          value={v.homeNode}
          onChange={(e) => setV({ ...v, homeNode: e.target.value })}
          className={inputClass}
        >
          {places.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!hydrated || pending} className={`${dark} w-full`}>
        Save details
      </button>
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </form>
  );
}
