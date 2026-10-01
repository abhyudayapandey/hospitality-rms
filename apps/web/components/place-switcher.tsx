'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { rememberPlace } from '@/app/(app)/actions';
import type { Screen } from '@/lib/place-screens';

export interface SwitcherPlace {
  id: string;
  name: string;
}

/**
 * "Viewing:" bar (ADR 016): the place a screen shows. With two or more places it is a
 * picker that remembers the choice for this screen; with one it is a plain label, or
 * nothing when `quiet` (the screen names its place already, e.g. Menu for one outlet).
 */
export function PlaceSwitcher({
  screen,
  places,
  current,
  quiet = false,
}: {
  screen: Screen;
  places: SwitcherPlace[];
  current: string;
  quiet?: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const here = places.find((p) => p.id === current);
  if (!here || (quiet && places.length < 2)) return null;
  return (
    <div
      data-testid="place-switcher"
      data-screen={screen}
      className="-mx-4 flex min-h-11 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm"
    >
      <span className="shrink-0 text-slate-600">Viewing:</span>
      {places.length < 2 ? (
        <span className="truncate font-medium" data-testid="viewing">
          {here.name}
        </span>
      ) : (
        <select
          aria-label="Viewing"
          value={current}
          disabled={pending}
          onChange={(e) => {
            const id = e.target.value;
            const q = new URLSearchParams(params.toString());
            q.set('node', id);
            start(async () => {
              await rememberPlace(screen, id);
              router.push(`${path}?${q.toString()}`);
            });
          }}
          className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-white px-2 font-medium"
        >
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
