import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import { Icon } from '@/components/icon';
import { ActionSync } from '@/components/action-sync';
import { PunchSync } from '@/components/punch-sync';
import { ShowAsBanner } from '@/components/show-as-banner';
import { ThemeToggle } from '@/components/theme-toggle';
import { NavProgress } from '@/components/nav-progress';
import { VersionCheck } from '@/components/version-check';
import { approvalsInNav, visibleNav } from '@/lib/nav';
import { loadShell, navInput } from '@/lib/shell';

/** "Priya Menon" → "PM" (UX-6: a face for the person, not a sign-out button). */
function initials(name: string): string {
  const parts = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

const badge =
  'absolute top-1 right-0.5 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await loadShell();
  const input = navInput(shell);
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 flex print:hidden items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <Link
          href="/profile"
          aria-label="Your profile"
          className="flex min-w-0 items-center gap-2.5 rounded-lg py-1"
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700"
          >
            {initials(shell.user.name)}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-sm font-semibold" data-testid="current-user">
                {shell.user.name}
              </span>
              {shell.jobTitle && (
                <span
                  className="shrink-[2] truncate text-xs text-slate-500"
                  data-testid="current-role"
                >
                  {shell.jobTitle}
                </span>
              )}
            </span>
            {shell.home && (
              <span className="block truncate text-xs text-slate-500" data-testid="home-place">
                {shell.home.name}
              </span>
            )}
          </span>
        </Link>
        <div className="flex items-center gap-1">
          {/* To do list is a tab for managers; for everyone else it is here (UX-6) */}
          {!approvalsInNav(input) && (
            <Link
              href="/inbox"
              aria-label={`To do list${shell.inboxCount ? `, ${shell.inboxCount} waiting` : ''}`}
              className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-700"
            >
              <Icon name="inbox" />
              {shell.inboxCount > 0 && (
                <span data-testid="header-inbox-count" className={badge}>
                  {shell.inboxCount}
                </span>
              )}
            </Link>
          )}
          <Link
            href="/notifications"
            aria-label={`Notifications${shell.unreadCount ? `, ${shell.unreadCount} unread` : ''}`}
            className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-700"
          >
            <Icon name="bell" />
            {shell.unreadCount > 0 && (
              <span data-testid="unread-count" className={badge}>
                {shell.unreadCount}
              </span>
            )}
          </Link>
          <ThemeToggle />
        </div>
      </header>
      {shell.user.presentedBy && (
        <ShowAsBanner name={shell.user.name} presenter={shell.user.presentedBy.name} />
      )}
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      <VersionCheck />
      <PunchSync userId={shell.user.id} />
      <ActionSync userId={shell.user.id} />
      <main className="flex-1 px-4 pt-4 pb-24 print:p-0">{children}</main>
      <div className="print:hidden">
        <BottomNav items={visibleNav(input)} inboxCount={shell.inboxCount} />
      </div>
    </div>
  );
}
