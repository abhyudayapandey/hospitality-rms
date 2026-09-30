import Link from 'next/link';
import type { PeopleContext } from '@/lib/people';
import { NodePicker } from './node-picker';

const TABS = [
  { href: '/roster/my', label: 'My shifts', domain: 'ROSTER', access: 'view' },
  { href: '/roster/clock', label: 'Clock', domain: 'ATTENDANCE', access: 'modify' },
  { href: '/leave', label: 'Leave', domain: 'LEAVE', access: 'view' },
  { href: '/roster/swaps', label: 'Swaps', domain: 'SHIFT_SWAPS', access: 'view' },
  { href: '/roster/week', label: 'Roster', domain: 'ROSTER', access: 'modify' },
  { href: '/roster/exceptions', label: 'Exceptions', domain: 'ATTENDANCE', access: 'modify' },
  { href: '/events', label: 'Events', domain: 'EVENTS', access: 'view' },
] as const;

export type PeopleTab = (typeof TABS)[number]['href'];

/** Title, the people tabs the user has, and (manager screens) an org location picker. */
export function PeopleHeader({
  ctx,
  active,
  title,
  picker = false,
}: {
  ctx: PeopleContext;
  active: PeopleTab;
  title: string;
  picker?: boolean;
}) {
  const tabs = TABS.filter((t) => ctx.can(t.domain, t.access));
  const q = picker && ctx.node ? `?node=${ctx.node.id}` : '';
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {picker && ctx.node && (
          <p className="truncate text-sm text-slate-600" data-testid="people-node">
            {ctx.node.name}
          </p>
        )}
      </div>
      {picker && ctx.node && (
        <NodePicker
          label="Location"
          nodes={ctx.nodes.map((n) => ({ id: n.id, label: n.name }))}
          current={ctx.node.id}
        />
      )}
      <nav aria-label="People" className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2">
          {tabs.map((t) => (
            <li key={t.href}>
              <Link
                href={`${t.href}${['/roster/week', '/roster/exceptions', '/events'].includes(t.href) ? q : ''}`}
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
    </div>
  );
}
