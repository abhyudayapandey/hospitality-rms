import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { formatQty, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { openPacks, packItems } from '@/lib/opened-packs';
import { OpenPackForm } from './open-form';
import { PackButtons } from '@/components/pack-buttons';

// Opened packs (ADR 093): the packs open at a store, soonest use-by first, each with its label,
// then opening another. Expired ones are in Stock → Expired too.
export default async function OpenedPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'opened');
  // "Open a pack" on an item's page comes here with the item chosen (ADR 097)
  const chosen = param(await searchParams, 'item');
  if (!ctx.can('SHELF_LIFE')) return <NoSupplyAccess />;
  // only stores that keep something with a shelf life once opened are offered (ADR 097)
  if (!ctx.node || ctx.node.derived) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Opened packs</h1>
        <Empty>Nothing kept in your stores has a shelf life once opened.</Empty>
      </div>
    );
  }
  const user = await requireUser();
  const node = ctx.node;
  const canOpen = ctx.can('SHELF_LIFE', 'modify');
  const { packs, items } = await withUser(user.id, async (tx) => ({
    packs: await openPacks(tx, node.id),
    items: canOpen ? await packItems(tx, node.id) : [],
  }));
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/opened" title="Opened packs" />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">Open now ({packs.length})</h2>
        {packs.length === 0 ? (
          <Empty>No opened packs here.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="open-packs"
          >
            {packs.map((p) => (
              <li key={p.id} className="space-y-2 px-4 py-3 text-sm" data-testid="open-pack">
                <div className="flex items-center gap-3">
                  <ItemThumb name={p.name} size="size-10" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-xs text-slate-500">
                      {formatQty(p.qty, p.unit)} · opened {formatWhen(p.opened_at)}
                      {p.opened_by && ` by ${p.opened_by}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span
                      className={`block text-xs ${p.expired ? 'text-rose-800' : 'text-slate-500'}`}
                    >
                      {p.expired ? 'Expired' : 'Use by'}
                    </span>
                    <span className="block font-medium tabular-nums" data-testid="pack-use-by">
                      {formatWhen(p.use_by)}
                    </span>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/stock/opened/label/${p.id}`}
                    className="inline-flex min-h-11 items-center text-sm font-medium underline"
                  >
                    Label
                  </Link>
                  {canOpen && <PackButtons pack={p.id} expired={p.expired} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canOpen && <OpenPackForm node={node.id} items={items} initial={chosen} />}
    </div>
  );
}
