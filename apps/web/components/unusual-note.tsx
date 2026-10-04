'use client';

import { useEffect, useState } from 'react';
import { checkUnusual, type Line, type UnusualCheck } from '@/app/(app)/stock/actions';

/**
 * Says before sending whether the department head will have to approve (PO-5, TR-3, ADR 043):
 * an item that is off the menu, or more than usual (a company setting times the week's use).
 * Nothing is shown for an order that goes through on its own beyond a short reassurance.
 */
export function UnusualNote({
  node,
  lines,
  kind,
}: {
  node: string;
  lines: Line[];
  kind: 'order' | 'transfer';
}) {
  const [check, setCheck] = useState<UnusualCheck | null>(null);
  const key = JSON.stringify(lines);
  useEffect(() => {
    if (lines.length === 0) {
      setCheck(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      checkUnusual(node, lines, kind)
        .then((r) => {
          if (live) setCheck(r.ok ? r.data : null);
        })
        .catch(() => {
          if (live) setCheck(null); // offline: the database still decides on submit
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [node, key, kind]);

  if (!check) return null;
  if (!check.needs) {
    return (
      <p data-testid="unusual-none" className="text-sm text-slate-600">
        Menu items in usual quantities: no approval needed.
      </p>
    );
  }
  return (
    <div
      data-testid="unusual-needs"
      className="space-y-1 rounded-lg bg-violet-50 p-3 text-sm text-violet-900"
    >
      <p className="font-medium">The department head will be asked to approve this:</p>
      <ul className="list-disc pl-5">
        {check.why.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}
