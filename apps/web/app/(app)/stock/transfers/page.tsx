import Link from 'next/link';
import { ItemThumbs } from '@/components/item-thumb';
import { PinnedActions } from '@/components/pinned-actions';
import { withBack } from '@/lib/back';
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
  const raw = param(sp, 'tab');
  const user = await requireUser();
  const node = ctx.node;
  const ids = ctx.nodes.map((n) => n.id);
  // the Main Store gives stock out: it opens on To send, 10 at a time, so Send stock is near
  // the top (ADR 053); elsewhere All, 30 at a time (ADR 052)
  const mainStore =
    !all &&
    (await withUser(
      user.id,
      async (tx) =>
        (await sql<{ m: boolean }>`select inv.is_main_store(${node.id}::uuid) as m`.execute(tx))
          .rows[0]?.m ?? false,
    ));
  const tab = raw === 'send' || (raw !== 'all' && mainStore) ? 'send' : 'all';
  const limit = listLimit(param(sp, 'n'), mainStore ? 10 : LIST_PAGE);
  const scope = all
    ? sql`(from_node_id = any(${ids}::uuid[]) or to_node_id = any(${ids}::uuid[]))`
    : sql`(from_node_id = ${node.id}::uuid or to_node_id = ${node.id}::uuid)`;
  // waiting to be sent from these stores: what the To send tab lists
  const sending = sql`(progress = 'awaiting_dispatch' and ${
    all ? sql`from_node_id = any(${ids}::uuid[])` : sql`from_node_id = ${node.id}::uuid`
  })`;
  const { rows: fetched, toSend } = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      from_node_id: string;
      to_node_id: string;
      from_name: string;
      to_name: string;
      progress: string;
      kind: string;
      created_at: Date;
      items: string | null;
    }>`
      select t.id, t.from_node_id, t.to_node_id, t.from_name, t.to_name, t.progress, t.kind,
             t.created_at,
             -- what is in it (ADR 053)
             (select string_agg(i.name, ', ' order by i.name)
                from inv.transfer_line l join inv.item i on i.id = l.item_id
               where l.transfer_id = t.id) as items
        from inv.transfer_summary t
       where ${scope} and (${tab === 'send'} = false or ${sending})
       order by created_at desc limit ${limit + 1}`.execute(tx);
    // counted in SQL with no limit, with the To send tab's own filter (ADR 052)
    const toSend = await sql<{ n: number }>`
      select count(*)::int as n from inv.transfer_summary where ${scope} and ${sending}`.execute(
      tx,
    );
    return { rows: r.rows, toSend: toSend.rows[0]?.n ?? 0 };
  });
  const rows = fetched.slice(0, limit);
  // "Test Hotel & Bar 1.0 – Kitchen Store" → "Kitchen Store": the outlet is the screen's (ADR 053)
  // under "All stores" two outlets can each have a Kitchen Store: the full name stays
  const short = (name: string) => (all ? name : (name.split(' – ').pop() ?? name));
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
            // the Main Store's default is To send, so All says so
            href: `${listHref('/stock/transfers', { all, node: node.id })}${mainStore ? '&tab=all' : ''}`,
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
                  href={withBack(
                    `/stock/transfers/${r.id}?node=${outgoing ? r.from_node_id : r.to_node_id}`,
                    `${listHref('/stock/transfers', { all, node: node.id, tab })}${mainStore && tab === 'all' ? '&tab=all' : ''}`,
                  )}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {r.kind === 'rfm' ? 'Request for material · ' : ''}
                      {r.kind === 'send' && outgoing ? 'Sent · ' : ''}
                      {outgoing ? `To ${short(r.to_name)}` : `From ${short(r.from_name)}`}
                    </span>
                    <span
                      data-testid="transfer-progress"
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                    >
                      {label}
                    </span>
                  </span>
                  {r.items && (
                    <span className="mt-1 flex items-center gap-2">
                      <ItemThumbs names={r.items} />
                      <span
                        className="min-w-0 truncate text-sm text-slate-700"
                        data-testid="transfer-items"
                      >
                        {r.items}
                      </span>
                    </span>
                  )}
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
            n: limit + (mainStore ? 10 : LIST_PAGE),
          })}
        />
      )}
      {/* the list first, then what to do (ADR 051); any stock location they move stock at
          (audit #5). The Main Store gives stock out: Send stock leads, asking is the exception */}
      {/* the main one kept in reach while the list runs past the screen (ADR 101) */}
      {canMove && (
        <PinnedActions label="Main actions">
          <Link
            href={mainStore ? `/stock/transfers/send${q}` : `/stock/transfers/new${q}`}
            className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
          >
            {mainStore ? 'Send stock' : 'Request stock'}
          </Link>
        </PinnedActions>
      )}
      {canMove && mainStore && (
        <Link
          href={`/stock/transfers/new${q}`}
          className="flex min-h-11 items-center justify-center text-sm font-medium text-brand-700 underline"
        >
          Request stock
        </Link>
      )}
    </div>
  );
}
