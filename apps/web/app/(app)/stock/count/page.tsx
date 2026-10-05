import Link from 'next/link';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { supplyContext, type SearchParams } from '@/lib/inventory';
import { StartCountButton } from './start-count';

export default async function CountPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'count');
  if (!ctx.can('STOCK_ADJUSTMENTS', 'modify') || !ctx.node || ctx.node.derived) {
    return <NoSupplyAccess />;
  }
  const user = await requireUser();
  const counts = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      status: string;
      started_at: Date;
      submitted_at: Date | null;
    }>`
      select id, status, started_at, submitted_at from inv.stock_count
       where delivery_node_id = ${ctx.node!.id}::uuid
       order by started_at desc limit 10`.execute(tx);
    return r.rows;
  });
  const open = counts.find((c) => c.status === 'open');
  const q = `?node=${ctx.node.id}`;
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/count" title="Stock count" />
      <p className="text-sm text-slate-600">
        Count what is on the shelf. Differences within each item&apos;s tolerance are posted
        straight away; bigger ones go to the outlet manager for approval.
      </p>
      {/* a count already started comes first: it is what to do now (ADR 053) */}
      {open && (
        <Link
          href={`/stock/count/${open.id}${q}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Continue the count started {formatWhen(open.started_at)}
        </Link>
      )}
      {counts.some((c) => c.status === 'submitted') && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Recent counts</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {counts
              .filter((c) => c.status === 'submitted')
              .map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/stock/count/${c.id}${q}`}
                    className="flex min-h-12 items-center px-4"
                  >
                    Submitted {formatWhen(c.submitted_at!)}
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}
      {/* the list first, then the action (ADR 051) */}
      {!open && <StartCountButton node={ctx.node.id} />}
    </div>
  );
}
