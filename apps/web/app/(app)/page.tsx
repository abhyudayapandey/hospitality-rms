import Link from 'next/link';
import { moreItems } from '@/lib/nav';
import { loadShell, navInput } from '@/lib/shell';

// Links to every main screen not in the bottom nav (ADR 020). Shortcuts need the same access as the tab they open (audit #3); shifts, clock and swaps
// only for people who work at an outlet (audit #13).
const can = (
  domains: Map<string, 'view' | 'modify'>,
  domain: string,
  access: 'view' | 'modify' = 'view',
) => domains.has(domain) && (access === 'view' || domains.get(domain) === 'modify');

export default async function Home() {
  const shell = await loadShell();
  const atWork = shell.home?.at_workplace ?? false;
  // what is not in their bottom nav (at most five items)
  const more = moreItems(navInput(shell));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Hello, {shell.user.name.split(' ')[0]}</h1>
      {shell.home && (
        <p className="text-sm text-slate-600">
          Working at <strong>{shell.home.name}</strong>
        </p>
      )}
      <Link
        href="/inbox"
        className="flex min-h-16 items-center justify-between rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      >
        <span className="font-medium">Waiting for you</span>
        <span className="text-2xl font-semibold" data-testid="inbox-count">
          {shell.inboxCount}
        </span>
      </Link>
      {more.length > 0 && (
        <nav aria-label="More" className="grid grid-cols-2 gap-2">
          {more.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-14 items-center justify-center gap-2 rounded-xl bg-white font-medium shadow-sm ring-1 ring-slate-200"
            >
              <span aria-hidden>{item.icon}</span>
              {item.label === 'Requests' ? 'My requests' : item.label}
            </Link>
          ))}
        </nav>
      )}
      <nav aria-label="People shortcuts" className="grid grid-cols-2 gap-2">
        {(
          [
            ['/roster/my', 'My shifts', atWork && can(shell.domains, 'ROSTER')],
            ['/roster/clock', 'Clock in', atWork && can(shell.domains, 'ATTENDANCE', 'modify')],
            ['/leave', 'Leave', can(shell.domains, 'LEAVE')],
            ['/events', 'Events', can(shell.domains, 'EVENTS')],
          ] as const
        )
          .filter(([, , show]) => show)
          .map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="flex min-h-14 items-center justify-center rounded-xl bg-white font-medium shadow-sm ring-1 ring-slate-200"
            >
              {label}
            </Link>
          ))}
      </nav>
      {(shell.domains.has('STOCK_LEVELS') || shell.production) && (
        <nav aria-label="Supply shortcuts" className="grid grid-cols-2 gap-2">
          {(
            [
              ['/stock', 'Stock', can(shell.domains, 'STOCK_LEVELS')],
              ['/stock/count', 'Count', can(shell.domains, 'STOCK_ADJUSTMENTS', 'modify')],
              ['/stock/wastage', 'Wastage', can(shell.domains, 'STOCK_ADJUSTMENTS', 'modify')],
              ['/stock/production', 'Production', shell.production],
              ['/stock/orders', 'Orders', can(shell.domains, 'PURCHASE_ORDERS')],
              ['/stock/transfers', 'Transfers', can(shell.domains, 'TRANSFERS')],
            ] as const
          )
            .filter(([, , show]) => show)
            .map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="flex min-h-14 items-center justify-center rounded-xl bg-white font-medium shadow-sm ring-1 ring-slate-200"
              >
                {label}
              </Link>
            ))}
        </nav>
      )}
    </div>
  );
}
