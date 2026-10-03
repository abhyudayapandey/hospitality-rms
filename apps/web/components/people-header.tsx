import Link from 'next/link';
import { tabAccess, type PeopleContext } from '@/lib/people';
import { PEOPLE_TABS, peopleTabs, type PeopleTab, type Side } from '@/lib/roster-view';
import { PlaceSwitcher } from './place-switcher';

export type { PeopleTab } from '@/lib/roster-view';

/**
 * Title, the "Place:" switcher on roster, exceptions and events (ADR 016), and the people
 * tabs on two sides (ADR 025): **Me** (my shifts, clock, leave, swaps) and **Team**
 * (roster, exceptions, events). The Me / Team switch shows only to people with both;
 * frontline staff see Me alone. My shifts, Clock and Swaps only for people who work at an
 * outlet (audit #13); Exceptions only for those who resolve them somewhere (audit #10).
 */
export function PeopleHeader({
  ctx,
  active,
  title,
}: {
  ctx: PeopleContext;
  active: PeopleTab;
  title: string;
}) {
  const sides = peopleTabs(tabAccess(ctx));
  const side: Side = PEOPLE_TABS.find((t) => t.href === active)!.side;
  const tabs = sides[side];
  // Team tabs keep the place on screen; Me tabs have none
  const href = (t: { href: string; side: Side }) =>
    t.side === 'team' && ctx.node ? `${t.href}?node=${ctx.node.id}` : t.href;
  return (
    <div className="space-y-3">
      {ctx.screen && ctx.node && (
        <PlaceSwitcher
          screen={ctx.screen}
          places={ctx.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind }))}
          current={ctx.node.id}
        />
      )}
      <h1 className="text-xl font-semibold">{title}</h1>
      {sides.me[0] && sides.team[0] && (
        <nav aria-label="Me or team" className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
          {(['me', 'team'] as const).map((s) => (
            <Link
              key={s}
              href={href(sides[s][0]!)}
              aria-current={s === side ? 'true' : undefined}
              className={`flex min-h-11 items-center justify-center rounded-lg text-sm ${
                s === side ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
              }`}
            >
              {s === 'me' ? 'Me' : 'Team'}
            </Link>
          ))}
        </nav>
      )}
      {tabs.length > 1 && (
        <nav aria-label={side === 'me' ? 'Me' : 'Team'} className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {tabs.map((t) => (
              <li key={t.href}>
                <Link
                  href={href(t)}
                  aria-current={t.href === active ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                    t.href === active
                      ? 'bg-brand-700 font-semibold text-white'
                      : 'bg-white text-slate-700 ring-1 ring-slate-300'
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
