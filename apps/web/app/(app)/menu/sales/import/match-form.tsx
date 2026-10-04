'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, secondaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { mapPosItem, repostPos } from '../../actions';

interface Unmatched {
  code: string;
  description: string;
  qty: number;
  value: number;
}

// For the people who post the outlet's sales: match each POS code to a dish on the
// outlet's menu (remembered for every later import), then post the day again.
export function MatchForm({
  outlet,
  importId,
  unmatched,
  menu,
}: {
  outlet: string;
  importId: string;
  unmatched: Unmatched[];
  menu: { id: string; name: string; group: string }[];
}) {
  const router = useRouter();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const groups = [...new Set(menu.map((m) => m.group))];

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {unmatched.map((u) => (
          <li
            key={u.code}
            className="space-y-1 rounded-lg p-3 ring-1 ring-slate-200"
            data-testid="pos-unmatched-row"
          >
            <p className="text-sm">
              <span className="font-medium">{u.description || u.code}</span>{' '}
              <span className="text-slate-500">
                (code {u.code}) · {u.qty} sold · {formatMoney(u.value)}
              </span>
            </p>
            <select
              aria-label={`Menu item for ${u.code}`}
              value={pick[u.code] ?? ''}
              onChange={(e) => setPick({ ...pick, [u.code]: e.target.value })}
              className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
            >
              <option value="">Not matched</option>
              {groups.map((g) => (
                <optgroup key={g} label={g === 'Bar' ? 'Drinks' : g}>
                  {menu
                    .filter((m) => m.group === g)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button
        type="button"
        className={secondaryButton}
        disabled={pending || Object.values(pick).every((v) => !v)}
        data-testid="pos-match"
        onClick={() =>
          start(async () => {
            setError(null);
            setDone(null);
            for (const [code, item] of Object.entries(pick)) {
              if (!item) continue;
              const r = await mapPosItem(outlet, code, item);
              if (!r.ok) {
                setError(r.message);
                return;
              }
            }
            const r = await repostPos(importId);
            if (!r.ok) {
              setError(r.message);
              return;
            }
            setDone(`Matched and posted again: ${r.data.posted} items.`);
            setPick({});
            router.refresh();
          })
        }
      >
        {pending ? 'Saving…' : 'Match and post the day again'}
      </button>
    </div>
  );
}
