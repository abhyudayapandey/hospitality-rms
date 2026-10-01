import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty, param, type SearchParams } from '@/lib/inventory';
import { menuPlaces } from '@/lib/menu';
import { costReport, isoDate, salesPlaces, todayIn, variance } from '@/lib/production';
import { MenuTabs } from '../parts';

// Cost control (ADR 015): per store and period, opening + receipts + transfers in −
// transfers out − wastage − theoretical use (sales and production) against the counts,
// with unexplained loss highlighted; and food and beverage cost % for the outlet.
export default async function VariancePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const to = isoDate(param(sp, 'to'), todayIn());
  const from = isoDate(param(sp, 'from'), todayIn('Asia/Kolkata', -6));
  const data = await withUser(user.id, async (tx) => {
    const places = await menuPlaces(tx);
    const stores = [...new Map(places.map((p) => [p.store_id, p])).values()];
    const place = stores.find((p) => p.store_id === param(sp, 'store')) ?? stores[0];
    if (!place) return null;
    return {
      stores,
      place,
      sales: (await salesPlaces(tx)).length > 0,
      rows: await variance(tx, place.store_id, from, to),
      costs: await costReport(tx, place.outlet_id, from, to),
    };
  });
  if (!data) return <Empty>You don&rsquo;t see costs anywhere.</Empty>;
  const moved = data.rows.filter(
    (r) =>
      Number(r.opening) !== 0 || Number(r.expected_closing) !== 0 || Number(r.variance_qty) !== 0,
  );
  const loss = data.rows.reduce((s, r) => s + Math.min(0, Number(r.variance_value)), 0);
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Variance</h1>
        <p className="truncate text-sm text-slate-600" data-testid="variance-store">
          {data.place.store_name}
        </p>
      </div>
      <MenuTabs active="variance" costs sales={data.sales} />
      <form className="grid grid-cols-2 gap-2" action="/menu/variance">
        <label className="col-span-2 space-y-1">
          <span className="text-sm">Store</span>
          <select
            name="store"
            defaultValue={data.place.store_id}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
          >
            {data.stores.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm">From</span>
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">To</span>
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
        <button className="col-span-2 min-h-12 rounded-lg border border-slate-300 bg-white">
          Show
        </button>
      </form>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">
          Cost % at {data.place.outlet_name} (prices before tax)
        </h2>
        {data.costs.length === 0 ? (
          <Empty>No sales posted in this period.</Empty>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {data.costs.map((c) => (
              <li
                key={c.menu}
                className="rounded-xl bg-white p-3 ring-1 ring-slate-200"
                data-testid="cost-pct-tile"
              >
                <p className="text-sm text-slate-600">{c.menu === 'Bar' ? 'Beverage' : 'Food'}</p>
                <p className="text-2xl font-semibold tabular-nums">{c.actual_pct ?? '–'}%</p>
                <p className="text-xs text-slate-500">
                  recipe {c.theoretical_pct ?? '–'}% · sales {formatMoney(c.revenue)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">
          Items {loss < 0 && <>· unexplained loss {formatMoney(-loss)}</>}
        </h2>
        {moved.length === 0 ? (
          <Empty>No stock moved here in this period.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {moved.map((r) => (
              <li
                key={r.item_id}
                data-testid="variance-row"
                data-sku={r.sku}
                className={`space-y-1 px-4 py-3 text-sm ${r.unexplained ? 'bg-rose-50' : ''}`}
              >
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span
                    className={`tabular-nums ${r.unexplained ? 'font-semibold text-rose-800' : ''}`}
                  >
                    {Number(r.variance_qty) === 0
                      ? r.counted
                        ? 'no variance'
                        : 'not counted'
                      : formatQty(r.variance_qty, r.unit)}
                    {Number(r.variance_value) !== 0 && <> · {formatMoney(r.variance_value)}</>}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  opening {formatQty(r.opening, r.unit)} + in{' '}
                  {formatQty(
                    Number(r.receipts) + Number(r.transfers_in) + Number(r.production_in),
                    r.unit,
                  )}{' '}
                  − out{' '}
                  {formatQty(
                    Number(r.transfers_out) + Number(r.wastage) + Number(r.other_use),
                    r.unit,
                  )}{' '}
                  − used {formatQty(Number(r.sales_use) + Number(r.production_out), r.unit)} =
                  expected {formatQty(r.expected_closing, r.unit)}
                  {Number(r.pending_qty) !== 0 && (
                    <> · {formatQty(r.pending_qty, r.unit)} awaiting approval</>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">
          Highlighted: a loss beyond the item&rsquo;s count tolerance. Count the store at the end of
          the period to see its variance.{' '}
          <Link className="underline" href={`/stock/count?node=${data.place.store_id}`}>
            Start a count
          </Link>
        </p>
      </section>
    </div>
  );
}
