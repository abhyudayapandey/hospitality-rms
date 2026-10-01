'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, secondaryButton, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { removeAccountOwner } from '../../actions';

export interface Owner {
  user_id: string;
  username: string;
  display_name: string;
  login_type: string;
  status: string;
  has_login: boolean;
  created_at: string;
  last_sign_in_at: string | null;
}

/**
 * The customer's account owners (ADR 013). An extra one (e.g. created by the console under
 * a username the files don't use) can be removed: the reason is audited, and the name must
 * be typed to confirm. The last owner can't be removed.
 */
export function AccountOwners({ tenantId, owners }: { tenantId: string; owners: Owner[] }) {
  const active = owners.filter((o) => o.status === 'active');
  // kept here, not on the row: a deleted owner's row is gone after the refresh
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section className="space-y-2" aria-label="Account owners">
      <h2 className="font-semibold">Account owners</h2>
      {active.length > 1 && (
        <p role="note" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          This customer has {active.length} account owners. If one was created by mistake, remove it
          here.
        </p>
      )}
      <StatusBox message={notice} />
      <ul className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200">
        {owners.map((o) => (
          <OwnerRow
            key={o.user_id}
            tenantId={tenantId}
            owner={o}
            removable={active.length > 1 && o.status === 'active'}
            onRemoved={setNotice}
          />
        ))}
      </ul>
    </section>
  );
}

function OwnerRow({
  tenantId,
  owner,
  removable,
  onRemoved,
}: {
  tenantId: string;
  owner: Owner;
  removable: boolean;
  onRemoved: (message: string) => void;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="space-y-2 p-3" data-owner={owner.username}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="font-medium">{owner.username}</span>{' '}
          <span className="text-slate-500">{owner.display_name}</span>
        </span>
        <span className="text-slate-600">
          {owner.login_type} · {owner.status} · {owner.has_login ? 'has a login' : 'no login'} ·{' '}
          {owner.last_sign_in_at ? 'has signed in' : 'never signed in'} · created{' '}
          {new Date(owner.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
        </span>
      </div>
      {removable && !open && (
        <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>
          Remove {owner.username}
        </button>
      )}
      {open && (
        <form
          aria-label={`Remove ${owner.username}`}
          className="space-y-2 rounded-lg bg-rose-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setError(null);
              const r = await removeAccountOwner(tenantId, owner.user_id, reason);
              if (!r.ok) {
                setError(r.message);
                return;
              }
              setOpen(false);
              onRemoved(
                r.data.mode === 'deleted'
                  ? `${r.data.username} was deleted: they never signed in and had no activity.`
                  : `${r.data.username} was deactivated and is no longer an account owner.`,
              );
              router.refresh();
            });
          }}
        >
          <p className="text-sm">
            <strong>{owner.username}</strong> is removed entirely if they never signed in and
            nothing refers to them; otherwise they are deactivated and lose Account Owner. Both are
            in the platform audit.
          </p>
          <label className="block text-sm font-medium">
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              className={inputClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Type {owner.username} to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className={inputClass}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!hydrated || pending || typed !== owner.username || !reason.trim()}
              className="min-h-11 rounded-lg bg-rose-700 px-4 font-medium text-white disabled:opacity-50"
            >
              Remove owner
            </button>
            <button type="button" className={secondaryButton} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ErrorBox message={error} />
    </li>
  );
}
