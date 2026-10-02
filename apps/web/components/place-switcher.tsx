'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { rememberPlace } from '@/app/(app)/actions';
import { groupPlaces, type NamedPlace, type Screen } from '@/lib/place-screens';

export type SwitcherPlace = NamedPlace;

/**
 * "Place:" bar (ADR 016): the place a screen shows. With two or more places it is a
 * picker that remembers the choice for this screen; with one it is a plain label, or
 * nothing when `quiet` (the screen names its place already, e.g. Menu for one outlet).
 * Options are grouped by outlet and named without it (UX review U-5). `collapsed` shows
 * the place with a Change button first, for screens where most people stay where they
 * are (reporting a problem, U-8).
 */
export function PlaceSwitcher({
  screen,
  places,
  current,
  quiet = false,
  collapsed = false,
}: {
  screen: Screen;
  places: SwitcherPlace[];
  current: string;
  quiet?: boolean;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(!collapsed);
  const here = places.find((p) => p.id === current);
  if (!here || (quiet && places.length < 2)) return null;
  return (
    <div
      data-testid="place-switcher"
      data-screen={screen}
      className="-mx-4 flex min-h-11 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm"
    >
      <span className="shrink-0 text-slate-600">Place:</span>
      {places.length < 2 || !open ? (
        <>
          <span className="min-w-0 flex-1 truncate font-medium" data-testid="viewing">
            {here.name}
          </span>
          {places.length > 1 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="min-h-11 shrink-0 px-2 text-slate-700 underline"
            >
              Change
            </button>
          )}
        </>
      ) : (
        <select
          aria-label="Place"
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
          {groupPlaces(places).map((g) => {
            const options = g.options.map((p) => (
              <option key={p.id} value={p.id} data-name={p.name}>
                {p.short}
              </option>
            ));
            return g.label ? (
              <optgroup key={g.label} label={g.label}>
                {options}
              </optgroup>
            ) : (
              options
            );
          })}
        </select>
      )}
    </div>
  );
}
