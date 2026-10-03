'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { rememberPlace } from '@/app/(app)/actions';
import { groupPlaces, type NamedPlace, type Screen } from '@/lib/place-screens';

export type SwitcherPlace = NamedPlace;

const ALL = 'all';

/**
 * "Place:" bar (ADR 016): the place a screen shows. With two or more places it is a
 * picker that remembers the choice for this screen; with one it is a plain label, or
 * nothing when `quiet` (the screen names its place already, e.g. Menu for one outlet).
 * Options are grouped by outlet and named without it (UX review U-5). `collapsed` shows
 * the place with a Change button first, for screens where most people stay where they
 * are (reporting a problem, U-8). `all` adds an "All stores"-style first option for lists
 * that can span the places (ADR 038): choosing it sets `all=1` and keeps the place, so
 * choosing a place again drops it.
 */
export function PlaceSwitcher({
  screen,
  places,
  current,
  quiet = false,
  collapsed = false,
  all,
}: {
  screen: Screen;
  places: SwitcherPlace[];
  current: string;
  quiet?: boolean;
  collapsed?: boolean;
  /** the "all" option's label, and whether it is the one shown */
  all?: { label: string; on: boolean } | undefined;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(!collapsed);
  const here = places.find((p) => p.id === current);
  if (!here || (quiet && places.length < 2 && !all)) return null;
  const picker = places.length > 1 || all !== undefined;
  return (
    <div
      data-testid="place-switcher"
      data-screen={screen}
      className="-mx-4 flex min-h-11 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1 text-sm"
    >
      <span className="shrink-0 text-slate-600">Place:</span>
      {!picker || !open ? (
        <>
          <span className="min-w-0 flex-1 truncate font-medium" data-testid="viewing">
            {all?.on ? all.label : here.name}
          </span>
          {picker && (
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
          value={all?.on ? ALL : current}
          disabled={pending}
          onChange={(e) => {
            const id = e.target.value;
            const q = new URLSearchParams(params.toString());
            if (id === ALL) {
              q.set('all', '1');
              start(() => router.push(`${path}?${q.toString()}`));
              return;
            }
            q.delete('all');
            q.set('node', id);
            start(async () => {
              await rememberPlace(screen, id);
              router.push(`${path}?${q.toString()}`);
            });
          }}
          className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-white px-2 font-medium"
        >
          {all && (
            <option value={ALL} data-name={all.label}>
              {all.label}
            </option>
          )}
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
