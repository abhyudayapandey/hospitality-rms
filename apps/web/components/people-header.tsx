import Link from 'next/link';
import type { PeopleContext } from '@/lib/people';
import { PlaceSwitcher } from './place-switcher';

const TABS = [
  { href: '/roster/my', label: 'My shifts', domain: 'ROSTER', access: 'view', personal: true },
  { href: '/roster/clock', label: 'Clock', domain: 'ATTENDANCE', access: 'modify', personal: true },
  { href: '/leave', label: 'Leave', domain: 'LEAVE', access: 'view', personal: false },
  { href: '/roster/swaps', label: 'Swaps', domain: 'SHIFT_SWAPS', access: 'view', personal: true },
  { href: '/roster/week', label: 'Roster', domain: 'ROSTER', access: 'modify', personal: false },
  {
    href: '/roster/exceptions',
    label: 'Exceptions',
    domain: null,
    access: 'modify',
    personal: false,
  },
  { href: '/events', label: 'Events', domain: 'EVENTS', access: 'view', personal: false },
] as const;

export type PeopleTab = (typeof TABS)[number]['href'];

/**
 * Title, the "Viewing:" switcher on roster, exceptions and events (ADR 016), and the
 * people tabs the user has. My shifts, Clock and Swaps only for people who work at an
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
  const tabs = TABS.filter(
    (t) =>
      (t.domain === null ? ctx.tabs.exceptions : ctx.can(t.domain, t.access)) &&
      (!t.personal || ctx.tabs.personal),
  );
  const q = ctx.node ? `?node=${ctx.node.id}` : '';
  return (
    <div className="space-y-3">
      {ctx.screen && ctx.node && (
        <PlaceSwitcher
          screen={ctx.screen}
          places={ctx.nodes.map((n) => ({ id: n.id, name: n.name }))}
          current={ctx.node.id}
        />
      )}
      <h1 className="text-xl font-semibold">{title}</h1>
      {tabs.length > 1 && (
        <nav aria-label="People" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {tabs.map((t) => (
              <li key={t.href}>
                <Link
                  href={`${t.href}${t.personal || t.href === '/leave' ? '' : q}`}
                  aria-current={t.href === active ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                    t.href === active
                      ? 'bg-slate-900 font-semibold text-white'
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
