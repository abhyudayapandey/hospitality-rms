import Link from 'next/link';
import type { ReactNode } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { PunchSync } from '@/components/punch-sync';
import { SignOutButton } from '@/components/sign-out-button';
import { visibleNav } from '@/lib/nav';
import { loadShell, navInput } from '@/lib/shell';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await loadShell();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <Link href="/profile" aria-label="Your profile" className="min-w-0 rounded-lg py-1">
          <p className="truncate text-sm font-semibold" data-testid="current-user">
            {shell.user.name}
          </p>
          {shell.home && (
            <p className="truncate text-xs text-slate-500" data-testid="home-place">
              {shell.home.name}
            </p>
          )}
        </Link>
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
      <PunchSync userId={shell.user.id} />
      <main className="flex-1 px-4 pt-4 pb-24">{children}</main>
      <BottomNav items={visibleNav(navInput(shell))} inboxCount={shell.inboxCount} />
    </div>
  );
}
