import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatQty, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { batches, madeHere, productionPlan } from '@/lib/production';
import { shelfLifeText, timeLeftText } from '@/lib/shelf-life';
import { ProductionForm } from './production-form';
import { ReportExpired } from './report-expired';

// Production (ADR 015): record a batch of a prep item made at this store. Ingredients leave
// by the recipe scaled to the batch (actual quantities can be changed), the batch arrives
// with a batch number and an expiry. Batches past their expiry are reported to the lead,
// who gives the discard (and a remake) to someone (ADR 020).
// The places are the stores where the person records production and something is made
// (stock users there, or PRODUCTION_TEAM through their department, ADR 016).
export default async function ProductionPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'production');
  if (!ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const canWaste = ctx.can('STOCK_ADJUSTMENTS', 'modify');
  const sp = await searchParams;
  const user = await requireUser();
  const node = ctx.node.id;
  const data = await withUser(user.id, async (tx) => {
    const items = await madeHere(tx, node).catch(() => []);
    const chosen = items.find((i) => i.item_id === param(sp, 'item')) ?? items[0];
    const plan = chosen ? await productionPlan(tx, node, chosen.item_id) : [];
    const held = await batches(tx, node).catch(() => []);
    return { items, chosen, plan, held };
  });
  const expired = data.held.filter((b) => b.expired);

  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/production" title="Production" />
      {expired.length > 0 && (
        <section
          className="space-y-2 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200"
          data-testid="expired"
        >
          <h2 className="font-semibold text-amber-900">
            Past their expiry: report them to your lead
          </h2>
          <ul className="space-y-2 text-sm">
            {expired.map((b) => (
              <li
                key={`${b.item_id}-${b.batch_no}`}
                className="flex items-center justify-between gap-2"
              >
                <span>
                  {b.name} · batch {b.batch_no} · {formatQty(b.remaining, b.unit)} left
                  {canWaste && (
                    <Link
                      className="block text-xs underline"
                      href={`/stock/wastage?node=${node}&item=${b.item_id}&qty=${Number(b.remaining)}&reason=expired`}
                    >
                      or record the wastage yourself
                    </Link>
                  )}
                </span>
                {b.batch_no && <ReportExpired store={node} item={b.item_id} batchNo={b.batch_no} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.items.length === 0 || !data.chosen ? (
        <Empty>Nothing is made at this store.</Empty>
      ) : (
        <>
          {data.items.length > 1 && (
            <nav aria-label="Prep item" className="-mx-4 overflow-x-auto px-4">
              <ul className="flex gap-2">
                {data.items.map((i) => (
                  <li key={i.item_id}>
                    <Link
                      href={`/stock/production?node=${node}&item=${i.item_id}`}
                      aria-current={i.item_id === data.chosen!.item_id ? 'true' : undefined}
                      className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                        i.item_id === data.chosen!.item_id
                          ? 'bg-slate-200 font-semibold'
                          : 'ring-1 ring-slate-300'
                      }`}
                    >
                      {i.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <ProductionForm
            key={data.chosen.item_id}
            node={node}
            item={data.chosen}
            shelfLife={shelfLifeText(data.plan[0]?.shelf_life_hours ?? null)}
            plan={data.plan.map((l) => ({
              ingredient_id: l.ingredient_id,
              name: l.name,
              qty: Number(l.qty),
              unit: l.unit,
            }))}
          />
        </>
      )}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">Batches here</h2>
        {data.held.length === 0 ? (
          <Empty>No batches held here.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {data.held.map((b) => (
              <li
                key={`${b.item_id}-${b.batch_no}-${String(b.expires_at)}`}
                data-testid="batch"
                className="flex justify-between gap-2 px-4 py-3 text-sm"
              >
                <span>
                  <span className="block font-medium">{b.name}</span>
                  <span className="text-xs text-slate-500">
                    batch {b.batch_no ?? '–'} · {timeLeftText(b.expires_at)}
                  </span>
                </span>
                <span
                  className={`text-right tabular-nums ${b.expired ? 'font-semibold text-amber-800' : ''}`}
                >
                  {formatQty(b.remaining, b.unit)}
                  {b.expired && <span className="block text-xs">expired</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
