import Link from 'next/link';
import { Icon } from '@/components/icon';
import { SignOutButton } from '@/components/sign-out-button';
import { visibleNav } from '@/lib/nav';
import { meGroups, type Screen } from '@/lib/screens';
import { loadShell, screenInput } from '@/lib/shell';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

// Me (UX-6, ADR 034, 106, 125, 132): every screen the person can open, nothing folded away,
// under headings: My work, My day, Team, Admin, then More. The bottom nav keeps three to five
// tabs; nothing is lost, it is here. Each tile needs the same access as the screen it opens.
export default async function MePage() {
  const shell = await loadShell();
  const input = screenInput(shell);
  const inNav = new Set(visibleNav(input).map((n) => n.href));
  const groups = meGroups(input, inNav);
  // asks not yet with the person (ADR 115), on Things I asked for, where Ask for something is
  const user = await requireUser();
  const openAsks = await withUser(user.id, async (tx) => {
    const r = await sql<{ open: number }>`
      select count(*)::int as open from inv.my_staff_asks(30)
       where stage not in ('given', 'closed')`.execute(tx);
    return r.rows[0]?.open ?? 0;
  });
  const tile = (x: Screen) => (
    <li key={x.href}>
      <Link
        href={x.href}
        data-testid={`me-${x.key}`}
        className="flex min-h-22 flex-col items-center justify-center gap-1.5 rounded-xl bg-white p-2 text-center text-sm font-medium shadow-sm ring-1 ring-slate-200"
      >
        <Icon name={x.icon} className="size-7 text-brand-700" />
        <span className="leading-tight">{x.label}</span>
        {x.key === 'requests' && openAsks > 0 && (
          <span
            className="rounded-full bg-amber-50 px-2 text-xs font-bold text-amber-800"
            data-testid="me-open-asks"
          >
            {openAsks}
          </span>
        )}
        {x.key === 'inbox' && shell.inboxCount > 0 && (
          <span className="rounded-full bg-rose-50 px-2 text-xs font-bold text-rose-700">
            {shell.inboxCount}
          </span>
        )}
      </Link>
    </li>
  );
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Me</h1>
      <div className="space-y-4" data-testid="me-tiles">
        {groups.map((g) => (
          <section key={g.group} aria-label={g.title} className="space-y-2">
            <h2
              className="text-xs font-semibold tracking-wide text-slate-500 uppercase"
              data-testid={`me-group-${g.group}`}
            >
              {g.title}
            </h2>
            <ul className="grid grid-cols-3 gap-2">{g.screens.map(tile)}</ul>
          </section>
        ))}
      </div>
      {shell.user.canShowAs && (
        <section aria-label="Demo" className="space-y-2">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Demo</h2>
          <Link
            href="/show-as"
            data-testid="me-show-as"
            className="flex min-h-14 items-center gap-3 rounded-xl bg-white p-3 text-sm font-medium shadow-sm ring-1 ring-slate-200"
          >
            <Icon name="people" className="size-7 text-brand-700" />
            <span>
              Show the app as someone
              <span className="block text-xs font-normal text-slate-500">
                See any person&apos;s screens, for a demo
              </span>
            </span>
          </Link>
        </section>
      )}
      <div className="flex justify-center">
        <SignOutButton />
      </div>
    </div>
  );
}
