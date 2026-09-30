import Link from 'next/link';
import type { ReactNode } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { NodeSwitcher } from '@/components/node-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import { visibleNav } from '@/lib/nav';
import { loadShell } from '@/lib/shell';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await loadShell();
  const options = shell.nodes.map((n) => ({
    id: n.id,
    label: `${n.name} · ${n.type === 'org' ? 'People' : 'Supply'}${n.derived ? ' (view)' : ''}`,
  }));
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" data-testid="current-user">
            {shell.user.name}
          </p>
          <NodeSwitcher options={options} current={shell.currentNode?.id ?? null} />
        </div>
        <div className="flex items-center gap-1">
          <Link
            href="/notifications"
            aria-label={`Notifications${shell.unreadCount ? `, ${shell.unreadCount} unread` : ''}`}
            className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg"
          >
            <span aria-hidden className="text-lg">
              🔔
            </span>
            {shell.unreadCount > 0 && (
              <span
                data-testid="unread-count"
                className="absolute top-1 right-0.5 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white"
              >
                {shell.unreadCount}
              </span>
            )}
          </Link>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-4 pt-4 pb-24">{children}</main>
      <BottomNav items={visibleNav(new Set(shell.domains.keys()))} inboxCount={shell.inboxCount} />
    </div>
  );
}
