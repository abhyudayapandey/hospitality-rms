import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { param, supplyContext, TRANSFER_PROGRESS, type SearchParams } from '@/lib/inventory';
import { ViewTabs } from '@/components/view-tabs';
import { listHref } from '@/lib/stock-view';

export default async function TransfersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'transfers');
  if (!ctx.can('TRANSFERS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  // "All stores" and the "To send" tab: what Home's Send count opens (ADR 048)
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const tab = param(sp, 'tab') === 'send' ? 'send' : 'all';
  const user = await requireUser();
  const node = ctx.node;
  const ids = ctx.nodes.map((n) => n.id);
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      from_node_id: string;
      to_node_id: string;
      from_name: string;
      to_name: string;
      progress: string;
      kind: string;
      created_at: Date;
    }>`
      select id, from_node_id, to_node_id, from_name, to_name, progress, kind, created_at
        from inv.transfer_summary
       where ${
         all
           ? sql`(from_node_id = any(${ids}::uuid[]) or to_node_id = any(${ids}::uuid[]))`
           : sql`(from_node_id = ${node.id}::uuid or to_node_id = ${node.id}::uuid)`
       }
         and (${tab === 'send'} = false
              or (progress = 'awaiting_dispatch'
                  and ${all ? sql`from_node_id = any(${ids}::uuid[])` : sql`from_node_id = ${node.id}::uuid`}))
       order by created_at desc limit 30`.execute(tx);
    return r.rows;
  });
  const toSend = rows.filter((r) => r.progress === 'awaiting_dispatch').length;
  const q = `?node=${node.id}`;
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader
        ctx={ctx}
        active="/stock/transfers"
        title="Transfers"
        all={ctx.nodes.length > 1 ? { label: 'All stores', on: all } : undefined}
      />
      <ViewTabs
        label="Transfers view"
        current={tab}
        tabs={[
          {
            key: 'all',
            label: 'All transfers',
            href: listHref('/stock/transfers', { all, node: node.id }),
          },
          {
            key: 'send',
            label: 'To send',
            count: tab === 'send' ? rows.length : toSend,
            href: listHref('/stock/transfers', { all, node: node.id, tab: 'send' }),
          },
        ]}
      />
      {/* any stock location they move stock at, a store or an outlet's own (audit #5) */}
      {!all && ctx.can('TRANSFERS', 'modify') && !node.derived && node.holds_stock && (
        <Link
          href={`/stock/transfers/new${q}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Request stock
        </Link>
      )}
      {rows.length === 0 ? (
        <Empty>
          {tab === 'send' ? 'Nothing is waiting to be sent.' : 'No transfers here yet.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const [label, style] = TRANSFER_PROGRESS[r.progress] ?? [r.progress, ''];
            const outgoing = all ? ids.includes(r.from_node_id) : r.from_node_id === node.id;
            return (
              <li key={r.id} data-testid="transfer-item" data-transfer-id={r.id}>
                <Link
                  href={`/stock/transfers/${r.id}?node=${outgoing ? r.from_node_id : r.to_node_id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {r.kind === 'rfm' ? 'Request for material · ' : ''}
                      {outgoing ? `To ${r.to_name}` : `From ${r.from_name}`}
                    </span>
                    <span
                      data-testid="transfer-progress"
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                    >
                      {label}
                    </span>
                  </span>
                  <span className="text-sm text-slate-600">{formatWhen(r.created_at)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
