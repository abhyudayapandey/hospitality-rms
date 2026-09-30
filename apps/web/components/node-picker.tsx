'use client';

import { usePathname, useRouter } from 'next/navigation';

export interface PickerNode {
  id: string;
  label: string;
}

/** Switches the node of the supply or people screens (?node=). */
export function NodePicker({
  nodes,
  current,
  label = 'Supply location',
}: {
  nodes: PickerNode[];
  current: string;
  label?: string;
}) {
  const router = useRouter();
  const path = usePathname();
  if (nodes.length < 2) return null;
  return (
    <select
      aria-label={label}
      value={current}
      onChange={(e) => router.push(`${path}?node=${e.target.value}`)}
      className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
    >
      {nodes.map((n) => (
        <option key={n.id} value={n.id}>
          {n.label}
        </option>
      ))}
    </select>
  );
}
