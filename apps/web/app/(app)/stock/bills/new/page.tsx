import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { supplyContext, type SearchParams } from '@/lib/inventory';
import { BillForm } from '../bill-form';

// A bill for a service with no stock: linen washing, pest control, repairs (BIL-2, ADR 050).
// Bills for goods are added on their order.
export default async function NewBillPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'bills');
  if (!ctx.can('BILLS', 'modify') || !ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const user = await requireUser();
  const suppliers = await withUser(user.id, async (tx) => {
    const r = await sql<{ id: string; name: string }>`
      select id, name from inv.supplier where archived_at is null order by name`.execute(tx);
    return r.rows;
  });
  const back = `/stock/bills?node=${ctx.node.id}`;
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600">
        ← Bills
      </Link>
      <h1 className="text-xl font-semibold">A bill for a service at {ctx.node.name}</h1>
      <p className="text-sm text-slate-600">
        For work with no stock, like linen washing, pest control or a repair. A bill for goods goes
        on its order.
      </p>
      <BillForm node={ctx.node.id} po={null} suppliers={suppliers} done={back} />
    </div>
  );
}
