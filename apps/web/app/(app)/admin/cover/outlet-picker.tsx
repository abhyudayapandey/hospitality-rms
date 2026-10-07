'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

const ALL = 'all';

/**
 * "Place:" for Who does what: "All outlets" first (ADR 038), then each outlet the admin may
 * look at. A plain label when there is only one.
 */
export function OutletPicker({
  outlets,
  current,
}: {
  outlets: { id: string; name: string }[];
  current: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div
      data-testid="place-switcher"
      className="-mx-4 flex min-h-11 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm"
    >
      <span className="shrink-0 text-slate-600">Place:</span>
      {outlets.length < 2 ? (
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="viewing">
          {outlets[0]?.name}
        </span>
      ) : (
        <select
          aria-label="Place"
          value={current ?? ALL}
          disabled={pending}
          onChange={(e) => {
            const id = e.target.value;
            start(() => router.push(id === ALL ? '/admin/cover' : `/admin/cover?outlet=${id}`));
          }}
          className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-white px-2 font-medium"
        >
          <option value={ALL}>All outlets</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
