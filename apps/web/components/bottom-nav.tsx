'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav';

export function BottomNav({ items, inboxCount }: { items: NavItem[]; inboxCount: number }) {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const active = item.href === '/' ? path === '/' : path.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs ${
                  active ? 'font-semibold text-slate-900' : 'text-slate-500'
                }`}
              >
                <span aria-hidden className="text-lg leading-none">
                  {item.icon}
                </span>
                <span data-testid="nav-label">{item.label}</span>
                {item.href === '/inbox' && inboxCount > 0 && (
                  <span
                    aria-label={`${inboxCount} waiting`}
                    className="absolute top-1.5 right-[calc(50%-1.4rem)] rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white"
                  >
                    {inboxCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
