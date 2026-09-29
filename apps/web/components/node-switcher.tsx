'use client';

import { useTransition } from 'react';
import { setCurrentNode } from '@/app/(app)/actions';

export interface NodeOption {
  id: string;
  label: string;
}

export function NodeSwitcher({
  options,
  current,
}: {
  options: NodeOption[];
  current: string | null;
}) {
  const [pending, start] = useTransition();
  if (options.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Location</span>
      <select
        aria-label="Location"
        value={current ?? ''}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          start(() => void setCurrentNode(id));
        }}
        className="min-h-11 max-w-[14rem] truncate rounded-lg border border-slate-300 bg-white px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
