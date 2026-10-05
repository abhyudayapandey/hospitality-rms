import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isUuid, param, supplyContext, type ItemOption, type SearchParams } from '@/lib/inventory';
import { TransferRequestForm } from './transfer-request-form';

export default async function NewTransferPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'transfers');
  if (!ctx.can('TRANSFERS', 'modify') || !ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const sp = await searchParams;
  const asked = param(sp, 'from');
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const sources = (
      await sql<{ id: string; name: string }>`
        select id::text, name from inv.transfer_sources(${ctx.node!.id}::uuid)`.execute(tx)
    ).rows;
    const from =
      asked && isUuid(asked) && sources.some((s) => s.id === asked)
        ? asked
        : (sources[0]?.id ?? null);
    // this store's items, and from its Main Store whatever the Main Store may give it (ADR 051)
    const items = (
      await sql<ItemOption>`
        select item_id::text, name, base_uom, on_hand::text, avg_cost::text, item_group
          from inv.request_items(${ctx.node!.id}::uuid, ${from}::uuid)`.execute(tx)
    ).rows;
    return { sources, from, items };
  });
  return (
    <div className="space-y-4">
      <Link href={`/stock/transfers?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Transfers
      </Link>
      <h1 className="text-xl font-semibold">Request stock for {ctx.node.name}</h1>
      <TransferRequestForm
        to={ctx.node.id}
        from={data.from}
        sources={data.sources}
        items={data.items}
      />
    </div>
  );
}
