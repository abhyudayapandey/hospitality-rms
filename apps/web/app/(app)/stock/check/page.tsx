import { InfoTip } from '@/components/info-tip';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { formatQty, supplyContext, type SearchParams } from '@/lib/inventory';
import { StartCheckButtons } from './start-check';

interface Row {
  item_id: string;
  name: string;
  unit: string;
  shelf: string | null;
  on_hand: string;
  verified_at: Date | null;
  verified_by: string | null;
  difference: string | null;
}

// The stock check (INV-10, ADR 043). Everyone with STOCK_CHECK at the store sees each item's
// Verified / Not verified tag, who verified it and when; the verifier also starts a check.
export default async function StockCheckPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'check');
  if (!ctx.node) return <NoSupplyAccess />;
  const node = ctx.node;
  const canCount = ctx.can('STOCK_CHECK', 'modify');
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const rows = await sql<Row>`
      select item_id, name, unit, shelf, on_hand, verified_at, verified_by, difference
        from inv.stock_check_view(${node.id}::uuid)`.execute(tx);
    const open = await sql<{ id: string }>`
      select id from inv.stock_check
       where delivery_node_id = ${node.id}::uuid and status <> 'finished' limit 1`.execute(tx);
    return { rows: rows.rows, open: open.rows[0]?.id ?? null };
  });
  const verified = data.rows.filter((r) => r.verified_at).length;
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/check" title="Stock check" />
      {/* a check under way is what to do now; otherwise the list comes first (ADR 051, 053) */}
      {canCount && !node.derived && data.open ? (
        <StartCheckButtons node={node.id} resume={data.open} />
      ) : null}
      <InfoTip label="How a stock check works">
        The verifier counts what is on the shelves without seeing what should be there, then sees
        the differences, adds a photo to each, and finishes. A difference changes stock at once and
        tells the department head and the GM.
      </InfoTip>
      {data.rows.length === 0 ? (
        <Empty>No items are set up here yet.</Empty>
      ) : (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">
            {verified} of {data.rows.length} verified
          </h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {data.rows.map((r) => (
              <li key={r.item_id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="text-xs text-slate-500">
                    {/* the count is blind: the verifier is not shown what should be there */}
                    {canCount ? r.unit : `${formatQty(r.on_hand, r.unit)} on record`}
                    {r.shelf ? ` · ${r.shelf}` : ''}
                  </span>
                </span>
                {r.verified_at ? (
                  <span
                    data-testid="tag-verified"
                    className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
                  >
                    Verified · {r.verified_by ?? 'someone'} · {formatWhen(r.verified_at)}
                  </span>
                ) : (
                  <span
                    data-testid="tag-not-verified"
                    className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600"
                  >
                    Not verified
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {canCount && !node.derived && !data.open ? (
        <StartCheckButtons node={node.id} resume={null} />
      ) : null}
    </div>
  );
}
