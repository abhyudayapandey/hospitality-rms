'use client';

import { usePathname, useRouter } from 'next/navigation';

export interface PickerNode {
  id: string;
  label: string;
}

/** Switches the delivery node of the supply screens (?node=). */
export function NodePicker({ nodes, current }: { nodes: PickerNode[]; current: string }) {
  const router = useRouter();
  const path = usePathname();
  if (nodes.length < 2) return null;
  return (
    <select
      aria-label="Supply location"
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
