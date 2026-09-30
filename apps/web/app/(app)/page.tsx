import Link from 'next/link';
import { loadShell } from '@/lib/shell';

export default async function Home() {
  const shell = await loadShell();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Hello, {shell.user.name.split(' ')[0]}</h1>
      {shell.currentNode && (
        <p className="text-sm text-slate-600">
          Working at <strong>{shell.currentNode.name}</strong>
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
        {[
          ['/roster/my', 'My shifts', 'ROSTER'],
          ['/roster/clock', 'Clock in', 'ATTENDANCE'],
          ['/leave', 'Leave', 'LEAVE'],
          ['/events', 'Events', 'EVENTS'],
        ]
          .filter(([, , d]) => shell.domains.has(d!))
          .map(([href, label]) => (
            <Link
              key={href}
              href={href!}
              className="flex min-h-14 items-center justify-center rounded-xl bg-white font-medium shadow-sm ring-1 ring-slate-200"
            >
              {label}
            </Link>
          ))}
      </nav>
      {shell.domains.has('STOCK_LEVELS') && (
        <nav aria-label="Supply shortcuts" className="grid grid-cols-2 gap-2">
          {[
            ['/stock', 'Stock', 'STOCK_LEVELS'],
            ['/stock/count', 'Count', 'STOCK_ADJUSTMENTS'],
            ['/stock/wastage', 'Wastage', 'STOCK_ADJUSTMENTS'],
            ['/stock/orders', 'Orders', 'PURCHASE_ORDERS'],
            ['/stock/transfers', 'Transfers', 'TRANSFERS'],
          ]
            .filter(([, , d]) => shell.domains.has(d!))
            .map(([href, label]) => (
              <Link
                key={href}
                href={href!}
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
