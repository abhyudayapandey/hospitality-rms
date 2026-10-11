import Link from 'next/link';
import { Icon } from '@/components/icon';
import { SignOutButton } from '@/components/sign-out-button';
import { visibleNav } from '@/lib/nav';
import { meTiles, type Screen } from '@/lib/screens';
import { loadShell, screenInput } from '@/lib/shell';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

// Me (UX-6, ADR 034, 106, 125): every screen the person can open, nothing folded away: their own
// work first, then their day (Shifts & leave, SOPs, Report a problem), then the rest. The
// bottom nav keeps three to five tabs; nothing is lost, it is here. Each tile needs the same
// access as the screen it opens.
export default async function MePage() {
  const shell = await loadShell();
  const input = screenInput(shell);
  const inNav = new Set(visibleNav(input).map((n) => n.href));
  const { mine, more } = meTiles(input, inNav);
  // asking the store their team uses for something (ADR 115): where they have one
  const user = await requireUser();
  const asks = await withUser(user.id, async (tx) => {
    const r = await sql<{ stores: boolean; open: number }>`
      select exists (select 1 from inv.my_ask_stores()) as stores,
             (select count(*)::int from inv.my_staff_asks(30)
               where stage not in ('given', 'closed')) as open`.execute(tx);
    return r.rows[0] ?? { stores: false, open: 0 };
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
      <ul className="grid grid-cols-3 gap-2" data-testid="me-tiles">
        {[...mine, ...more].map(tile)}
      </ul>
      {asks.stores && (
        <Link
          href="/stock/asks"
          data-testid="me-asks"
          className="flex min-h-14 items-center gap-3 rounded-xl bg-white p-3 text-sm font-medium shadow-sm ring-1 ring-slate-200"
        >
          <Icon name="box" className="size-7 text-brand-700" />
          <span className="flex-1">
            Ask for something
            <span className="block text-xs font-normal text-slate-500">
              {asks.open > 0
                ? `${asks.open} asked, not yet with you`
                : 'From the store your team uses'}
            </span>
          </span>
        </Link>
      )}
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
