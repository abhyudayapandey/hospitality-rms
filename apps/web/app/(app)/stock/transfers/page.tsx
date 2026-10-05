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
import { LIST_PAGE, listLimit } from '@/lib/list-page';
import { ShowMore } from '@/components/show-more';

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
  // the latest LIST_PAGE, then "Show more"; the counts have no limit (ADR 052)
  const limit = listLimit(param(sp, 'n'));
  const scope = all
    ? sql`(from_node_id = any(${ids}::uuid[]) or to_node_id = any(${ids}::uuid[]))`
    : sql`(from_node_id = ${node.id}::uuid or to_node_id = ${node.id}::uuid)`;
  // waiting to be sent from these stores: what the To send tab lists
  const sending = sql`(progress = 'awaiting_dispatch' and ${
    all ? sql`from_node_id = any(${ids}::uuid[])` : sql`from_node_id = ${node.id}::uuid`
  })`;
  const {
    rows: fetched,
    toSend,
    mainStore,
  } = await withUser(user.id, async (tx) => {
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
       where ${scope} and (${tab === 'send'} = false or ${sending})
       order by created_at desc limit ${limit + 1}`.execute(tx);
    // counted in SQL with no limit, with the To send tab's own filter (ADR 052)
    const toSend = await sql<{ n: number }>`
      select count(*)::int as n from inv.transfer_summary where ${scope} and ${sending}`.execute(
      tx,
    );
    const main = await sql<{ m: boolean }>`select inv.is_main_store(${node.id}::uuid) as m`.execute(
      tx,
    );
    return {
      rows: r.rows,
      toSend: toSend.rows[0]?.n ?? 0,
      mainStore: main.rows[0]?.m ?? false,
    };
  });
  const rows = fetched.slice(0, limit);
  const q = `?node=${node.id}`;
  const canMove = !all && ctx.can('TRANSFERS', 'modify') && !node.derived && node.holds_stock;
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
            count: toSend,
            href: listHref('/stock/transfers', { all, node: node.id, tab: 'send' }),
          },
        ]}
      />
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
                      {r.kind === 'send' && outgoing ? 'Sent · ' : ''}
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
      {fetched.length > limit && (
        <ShowMore
          href={listHref('/stock/transfers', {
            all,
            node: node.id,
            tab,
            n: limit + LIST_PAGE,
          })}
        />
      )}
      {/* the list first, then what to do (ADR 051); any stock location they move stock at
          (audit #5). The Main Store gives stock out: Send stock leads, asking is the exception */}
      {canMove && mainStore && (
        <Link
          href={`/stock/transfers/send${q}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Send stock
        </Link>
      )}
      {canMove && (
        <Link
          href={`/stock/transfers/new${q}`}
          className={
            mainStore
              ? 'flex min-h-11 items-center justify-center text-sm font-medium text-brand-700 underline'
              : 'flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white'
          }
        >
          Request stock
        </Link>
      )}
    </div>
  );
}
