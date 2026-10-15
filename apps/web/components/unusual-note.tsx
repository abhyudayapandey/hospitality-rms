'use client';

import { useEffect, useState } from 'react';
import { checkUnusual, type Line, type UnusualCheck } from '@/app/(app)/stock/actions';
import { approvalHeadline } from '@/lib/approval-words';

/**
 * Says before sending whether it will wait for a yes and whose (PO-5, TR-3, ADR 044, 142): the
 * GM or the department head, as the outlet's rules decide (an item off the menu, more than
 * usual, or every one). Nothing is shown for one that goes through on its own beyond a short
 * reassurance.
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
        No approval needed.
      </p>
    );
  }
  return (
    <div
      data-testid="unusual-needs"
      className="space-y-1 rounded-lg bg-violet-50 p-3 text-sm text-violet-900"
    >
      <p className="font-medium">{approvalHeadline(check, kind)}</p>
      {check.why.length > 0 && (
        <ul className="list-disc pl-5">
          {check.why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
