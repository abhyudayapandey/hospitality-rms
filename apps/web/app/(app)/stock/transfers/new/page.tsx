import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { isUuid, param } from '@/lib/params';
import { sql, withUser } from '@/lib/db';
import { supplyContext, type SearchParams } from '@/lib/inventory';
import { TransferRequestForm, type AskItem } from './transfer-request-form';

// Request from a store (ADR 115, 144): the department says what and how many; each item goes to the store
// it comes from by the outlet's rules (the Main Store, else the store that keeps it), so nobody
// picks a store. What no other store keeps is bought instead.
export default async function NewTransferPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'transfers');
  if (!ctx.can('TRANSFERS', 'modify') || !ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const user = await requireUser();
  // opened from an item's page: that item first (ADR 134)
  const asked = param(await searchParams, 'item');
  const focus = isUuid(asked) ? asked : undefined;
  const items = await withUser(
    user.id,
    async (tx) =>
      (
        await sql<AskItem>`
          select item_id::text, name, base_uom, on_hand::text, null::text as avg_cost, item_group,
                 par_level::text, source_id::text, source_name, source_on_hand::text
            from inv.ask_items(${ctx.node!.id}::uuid)`.execute(tx)
      ).rows,
  );
  return (
    <div className="space-y-4">
      <Link href={`/stock/transfers?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Back
      </Link>
      <h1 className="text-xl font-semibold">Request from a store for {ctx.node.name}</h1>
      <TransferRequestForm to={ctx.node.id} items={items} focus={focus} />
    </div>
  );
}
