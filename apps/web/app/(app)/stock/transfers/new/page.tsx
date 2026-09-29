import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { itemOptions, supplyContext, type SearchParams } from '@/lib/inventory';
import { TransferRequestForm } from './transfer-request-form';

export default async function NewTransferPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams);
  if (!ctx.can('TRANSFERS', 'modify') || !ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => ({
    items: await itemOptions(tx, ctx.node!.id),
    sources: (
      await sql<{ id: string; name: string }>`
        select id, name from inv.transfer_sources(${ctx.node!.id}::uuid)`.execute(tx)
    ).rows,
  }));
  return (
    <div className="space-y-4">
      <Link href={`/stock/transfers?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Transfers
      </Link>
      <h1 className="text-xl font-semibold">Request stock for {ctx.node.name}</h1>
      <TransferRequestForm to={ctx.node.id} sources={data.sources} items={data.items} />
    </div>
  );
}
