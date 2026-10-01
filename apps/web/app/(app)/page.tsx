import Link from 'next/link';
import { loadShell } from '@/lib/shell';

// Shortcuts need the same access as the tab they open (audit #3); shifts, clock and swaps
// only for people who work at an outlet (audit #13).
const can = (
  domains: Map<string, 'view' | 'modify'>,
  domain: string,
  access: 'view' | 'modify' = 'view',
) => domains.has(domain) && (access === 'view' || domains.get(domain) === 'modify');

export default async function Home() {
  const shell = await loadShell();
  const atWork = shell.home?.at_workplace ?? false;
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
      <Link
        href="/requests"
        className="flex min-h-16 items-center rounded-xl bg-white p-4 font-medium shadow-sm ring-1 ring-slate-200"
      >
        My requests
      </Link>
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
