import Link from 'next/link';
import type { TaskTabs } from '@/lib/tasks';
import { PlaceSwitcher, type SwitcherPlace } from './place-switcher';
import type { Screen } from '@/lib/place-screens';

const TABS = [
  { href: '/tasks', label: 'Mine', show: () => true },
  { href: '/tasks/team', label: 'Team', show: (t: TaskTabs) => t.team },
  { href: '/tasks/checklists', label: 'Checklists', show: (t: TaskTabs) => t.checklists },
  { href: '/tasks/prep', label: 'Prep list', show: (t: TaskTabs) => t.prep },
  { href: '/tasks/maintenance', label: 'Maintenance', show: (t: TaskTabs) => t.maintenance },
] as const;

export type TasksTab = (typeof TABS)[number]['href'];

/** Title, the "Place:" switcher where the screen shows one place, and the task tabs. */
export function TasksHeader({
  tabs,
  active,
  title,
  switcher,
}: {
  tabs: TaskTabs;
  active: TasksTab | null;
  title: string;
  switcher?:
    | {
        screen: Screen;
        places: SwitcherPlace[];
        current: string;
        collapsed?: boolean;
        all?: { label: string; on: boolean };
      }
    | undefined;
}) {
  const shown = TABS.filter((t) => t.show(tabs));
  return (
    <div className="space-y-3">
      {switcher && <PlaceSwitcher {...switcher} />}
      <h1 className="text-xl font-semibold">{title}</h1>
      {shown.length > 1 && (
        <nav aria-label="Tasks" className="px-0">
          <ul className="flex flex-wrap gap-2">
            {shown.map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
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
