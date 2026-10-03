import Link from 'next/link';
import { Icon } from '@/components/icon';
import { SignOutButton } from '@/components/sign-out-button';
import { visibleNav } from '@/lib/nav';
import { SECTION_TITLES, screensFor, type ScreenSection } from '@/lib/screens';
import { loadShell, screenInput } from '@/lib/shell';

// Me (UX-6, ADR 034): the person's own things, then every other screen they can open, as
// tiles with drawn icons. The bottom nav keeps three to five tabs; nothing is lost, it is
// here. Each tile needs the same access as the screen it opens.
export default async function MePage() {
  const shell = await loadShell();
  const input = screenInput(shell);
  const inNav = new Set(visibleNav(input).map((n) => n.href));
  const screens = screensFor(input).filter((s) => !inNav.has(s.href));
  const sections = (['mine', 'work', 'team'] as const satisfies readonly ScreenSection[])
    .map((key) => ({ key, screens: screens.filter((s) => s.section === key) }))
    .filter((s) => s.screens.length > 0);
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Me</h1>
      {sections.map((s) => (
        <section key={s.key} aria-label={SECTION_TITLES[s.key]} className="space-y-2">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            {SECTION_TITLES[s.key]}
          </h2>
          <ul className="grid grid-cols-3 gap-2">
            {s.screens.map((x) => (
              <li key={x.href}>
                <Link
                  href={x.href}
                  data-testid={`me-${x.key}`}
                  className="flex min-h-22 flex-col items-center justify-center gap-1.5 rounded-xl bg-white p-2 text-center text-sm font-medium shadow-sm ring-1 ring-slate-200"
                >
                  <Icon name={x.icon} className="size-7 text-brand-700" />
                  <span className="leading-tight">{x.label}</span>
                  {x.key === 'inbox' && shell.inboxCount > 0 && (
                    <span className="rounded-full bg-rose-50 px-2 text-xs font-bold text-rose-700">
                      {shell.inboxCount}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="flex justify-center">
        <SignOutButton />
      </div>
    </div>
  );
}
